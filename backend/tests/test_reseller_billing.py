"""
Unit tests for the Platform Fleet Rental pricing engine and gateway encryption.
Uses standard library unittest so it runs everywhere without extra dependencies.
"""

import unittest
from app.services.reseller_billing import (
    compute_model_a_wholesale,
    compute_model_b_commission,
    compute_reseller_net_model_b,
    compute_lifetime_hosting,
    compute_monthly_charge,
)
from app.services.gateway_crypto import (
    encrypt_credential,
    decrypt_credential,
    mask_credential,
)


class TestResellerBilling(unittest.TestCase):

    def test_model_a_wholesale_benchmarks(self):
        benchmarks = [
            (0, 0.00),
            (1, 20.00),       # Minimum applies
            (5, 20.00),       # 5 vehicles = $20 minimum
            (10, 32.50),      # 20 + 5*2.50 = 32.50
            (25, 70.00),      # 20 + 20*2.50 = 70.00
            (50, 120.00),     # 70 + 25*2.00 = 120.00
            (75, 170.00),     # 70 + 50*2.00 = 170.00
            (100, 207.50),    # 170 + 25*1.50 = 207.50
            (150, 282.50),    # 170 + 75*1.50 = 282.50
            (200, 357.50),    # 170 + 125*1.50 = 357.50
            (300, 482.50),    # 357.50 + 100*1.25 = 482.50
            (500, 732.50),    # 357.50 + 300*1.25 = 732.50
            (1000, 1232.50),  # 732.50 + 500*1.00 = 1232.50
        ]
        for vehicles, expected in benchmarks:
            result = compute_model_a_wholesale(vehicles)
            self.assertEqual(result, expected, f"{vehicles} vehicles expected ${expected}, got ${result}")

    def test_model_a_custom_bands(self):
        """Verify Super Admin can override progressive bands without modifying code."""
        custom_bands = [
            {"up_to": 10, "rate": None, "flat_minimum": 50.00},
            {"up_to": 50, "rate": 3.00, "flat_minimum": None},
            {"up_to": None, "rate": 2.00, "flat_minimum": None},
        ]
        # 5 vehicles -> $50 flat
        self.assertEqual(compute_model_a_wholesale(5, custom_bands), 50.00)
        # 10 vehicles -> $50 flat
        self.assertEqual(compute_model_a_wholesale(10, custom_bands), 50.00)
        # 20 vehicles -> $50 + 10 * $3.00 = $80
        self.assertEqual(compute_model_a_wholesale(20, custom_bands), 80.00)
        # 60 vehicles -> $50 + 40 * $3.00 + 10 * $2.00 = 50 + 120 + 20 = $190
        self.assertEqual(compute_model_a_wholesale(60, custom_bands), 190.00)

    def test_model_b_commission_benchmarks(self):
        benchmarks = [
            (50.00, 20.00, 30.00),     # Floor applies ($50 * 20% = $10 < $20)
            (100.00, 20.00, 80.00),    # Floor applies ($100 * 20% = $20 == $20)
            (200.00, 40.00, 160.00),   # 20% > floor ($40 > $20)
            (500.00, 100.00, 400.00),  # 20% = $100
            (1000.00, 200.00, 800.00), # 20% = $200
        ]
        for revenue, exp_inferth, exp_reseller in benchmarks:
            inferth = compute_model_b_commission(revenue)
            reseller = compute_reseller_net_model_b(revenue)
            self.assertEqual(inferth, exp_inferth, f"Revenue ${revenue}: expected Inferth ${exp_inferth}, got ${inferth}")
            self.assertEqual(reseller, exp_reseller, f"Revenue ${revenue}: expected Reseller ${exp_reseller}, got ${reseller}")

    def test_lifetime_hosting_benchmarks(self):
        benchmarks = [
            (0, 0.00),
            (1, 1.50),
            (10, 15.00),
            (50, 75.00),
            (100, 150.00),
        ]
        for count, expected in benchmarks:
            self.assertEqual(compute_lifetime_hosting(count), expected)

    def test_combined_billing_model_a(self):
        summary = compute_monthly_charge(
            model="MODEL_A",
            active_vehicles=100,
            eligible_revenue_usd=1500.00,
        )
        self.assertEqual(summary["wholesale_charge"], 207.50)
        self.assertEqual(summary["total_due"], 207.50)
        self.assertEqual(summary["commission"], 0.00)
        self.assertEqual(summary["lifetime_hosting"], 0.00)
        self.assertEqual(summary["reseller_net"], 1292.50)

    def test_combined_billing_model_b(self):
        summary = compute_monthly_charge(
            model="MODEL_B",
            active_vehicles=50,
            eligible_revenue_usd=600.00,
            active_lifetime_vehicles=10,
        )
        # Commission: 20% of $600 = $120
        # Lifetime hosting: 10 * $1.50 = $15
        # Total due to Inferth: $135
        self.assertEqual(summary["commission"], 120.00)
        self.assertEqual(summary["lifetime_hosting"], 15.00)
        self.assertEqual(summary["total_due"], 135.00)
        self.assertEqual(summary["wholesale_charge"], 0.00)
        self.assertEqual(summary["reseller_net"], 465.00)

    def test_gateway_encryption_roundtrip(self):
        secret_id = "28184"
        secret_key = "a8b9c1d2-e3f4-5678-90ab-cdef12345678"

        enc_id = encrypt_credential(secret_id)
        enc_key = encrypt_credential(secret_key)

        self.assertNotEqual(enc_id, secret_id)
        self.assertNotEqual(enc_key, secret_key)

        self.assertEqual(decrypt_credential(enc_id), secret_id)
        self.assertEqual(decrypt_credential(enc_key), secret_key)

    def test_credential_masking(self):
        self.assertEqual(mask_credential("28184", 2, 2), "28*84")
        self.assertEqual(mask_credential("1234567890", 2, 2), "12******90")
        self.assertEqual(mask_credential("short", 2, 2), "sh*rt")
        self.assertEqual(mask_credential("ab", 2, 2), "***")
        self.assertEqual(mask_credential("", 2, 2), "")


if __name__ == "__main__":
    unittest.main()
