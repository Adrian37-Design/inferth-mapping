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
            (1, 15.00),       # Minimum applies ($15)
            (5, 15.00),       # 5 vehicles = $15 minimum
            (10, 27.50),      # 15 + 5*2.50 = 27.50
            (25, 65.00),      # 15 + 20*2.50 = 65.00
            (50, 115.00),     # 65 + 25*2.00 = 115.00
            (75, 165.00),     # 65 + 50*2.00 = 165.00
            (100, 202.50),    # 165 + 25*1.50 = 202.50
            (150, 277.50),    # 165 + 75*1.50 = 277.50
            (200, 352.50),    # 165 + 125*1.50 = 352.50
            (300, 477.50),    # 352.50 + 100*1.25 = 477.50
            (500, 727.50),    # 352.50 + 300*1.25 = 727.50
            (1000, 1227.50),  # 727.50 + 500*1.00 = 1227.50
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
            (50.00, 15.00, 35.00),     # Floor applies ($50 * 20% = $10 < $15)
            (75.00, 15.00, 60.00),     # Floor applies ($75 * 20% = $15 == $15)
            (100.00, 20.00, 80.00),    # 20% > floor ($20 > $15)
            (200.00, 40.00, 160.00),   # 20% > floor ($40 > $15)
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
        self.assertEqual(summary["wholesale_charge"], 202.50)
        self.assertEqual(summary["total_due"], 202.50)
        self.assertEqual(summary["commission"], 0.00)
        self.assertEqual(summary["lifetime_hosting"], 0.00)
        self.assertEqual(summary["reseller_net"], 1297.50)

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
