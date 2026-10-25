import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

from fastapi import HTTPException
from pydantic import ValidationError

from app.routers.devices import CommandPayload, DeviceProfileIn, send_device_command, update_device_profile


class CommandPayloadTests(unittest.TestCase):
    def test_only_supported_commands_are_accepted(self):
        for action in ("shutdown", "sleep", "lock", "restore", "unlock"):
            with self.subTest(action=action):
                self.assertEqual(CommandPayload(action=action).action, action)

        for action in ("beep", "restart", "", "SHUTDOWN"):
            with self.subTest(action=action):
                with self.assertRaises(ValidationError):
                    CommandPayload(action=action)


class QueuedCommandTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.device = SimpleNamespace(
            id=1, imei="123456789012345", name="Test asset", tenant_id=2,
            device_metadata={},
        )
        self.user = SimpleNamespace(id=7, email="manager@example.test", tenant_id=2)
        result = Mock()
        result.scalars.return_value.first.return_value = self.device
        self.db = SimpleNamespace(
            execute=AsyncMock(return_value=result), add=Mock(),
            commit=AsyncMock(), refresh=AsyncMock(),
        )

    async def test_engine_lock_is_queued_not_reported_as_executed(self):
        response = await send_device_command(1, CommandPayload(action="lock"), self.db, self.user)
        self.assertEqual(response["command_status"], "queued")
        self.assertIn("ENGINE_LOCK queued", response["message"])
        self.assertIn("not confirmed", response["message"])
        self.assertIn("not a tracker sleep command", response["message"])
        self.assertEqual(self.device.device_metadata["pending_command"], "LOCK")
        self.assertTrue(self.device.device_metadata["is_shutdown"])
        self.db.commit.assert_awaited_once()

    async def test_legacy_shutdown_action_preserves_tracker_wire_contract(self):
        response = await send_device_command(1, CommandPayload(action="shutdown"), self.db, self.user)
        self.assertEqual(self.device.device_metadata["pending_command"], "SHUTDOWN")
        self.assertIn("ENGINE_LOCK queued", response["message"])

    async def test_restore_requests_unlock_without_claiming_physical_state(self):
        response = await send_device_command(1, CommandPayload(action="restore"), self.db, self.user)
        self.assertIn("ENGINE_UN_LOCK queued", response["message"])
        self.assertFalse(self.device.device_metadata["is_shutdown"])

    async def test_command_cannot_target_another_tenant(self):
        self.user.tenant_id = 3
        with self.assertRaises(HTTPException) as error:
            await send_device_command(1, CommandPayload(action="lock"), self.db, self.user)
        self.assertEqual(error.exception.status_code, 403)
        self.db.commit.assert_not_awaited()

    async def test_unknown_device_does_not_queue_a_command(self):
        self.db.execute.return_value.scalars.return_value.first.return_value = None
        with self.assertRaises(HTTPException) as error:
            await send_device_command(1, CommandPayload(action="lock"), self.db, self.user)
        self.assertEqual(error.exception.status_code, 404)
        self.db.commit.assert_not_awaited()


class DeviceProfileTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.device = SimpleNamespace(
            id=1, imei="123456789012345", name="Test asset", tenant_id=2,
            device_metadata={"is_shutdown": True},
        )
        self.user = SimpleNamespace(id=7, email="manager@example.test", tenant_id=2)
        result = Mock()
        result.scalars.return_value.first.return_value = self.device
        self.db = SimpleNamespace(
            execute=AsyncMock(return_value=result), add=Mock(),
            commit=AsyncMock(), refresh=AsyncMock(),
        )

    async def test_profile_fields_merge_without_dropping_existing_metadata(self):
        response = await update_device_profile(
            1, DeviceProfileIn(model=" Hilux ", plate="AEC 1234", sim="+263 77 123 4567"), self.db, self.user)
        self.assertEqual(self.device.device_metadata, {
            "is_shutdown": True, "model": "Hilux", "plate": "AEC 1234", "sim": "+263 77 123 4567"})
        self.assertEqual(response["device_metadata"]["plate"], "AEC 1234")
        self.db.commit.assert_awaited_once()

    async def test_blank_value_clears_field_and_omitted_field_is_untouched(self):
        self.device.device_metadata = {"model": "Hilux", "plate": "AEC 1234"}
        await update_device_profile(1, DeviceProfileIn(plate="   "), self.db, self.user)
        self.assertEqual(self.device.device_metadata, {"model": "Hilux", "plate": None})

    async def test_invalid_plate_or_sim_is_rejected(self):
        for kwargs in ({"sim": "call me"}, {"sim": "12"}, {"sim": "+263 77 abc"}, {"plate": "AB<script>"}):
            with self.subTest(**kwargs):
                with self.assertRaises(ValidationError):
                    DeviceProfileIn(**kwargs)

    async def test_vin_is_saved_in_capitals_and_accepts_older_chassis_numbers(self):
        await update_device_profile(1, DeviceProfileIn(vin=" kzn165-0012345 "), self.db, self.user)
        self.assertEqual(self.device.device_metadata["vin"], "KZN165-0012345")
        await update_device_profile(1, DeviceProfileIn(vin="1HGCM82633A004352"), self.db, self.user)
        self.assertEqual(self.device.device_metadata["vin"], "1HGCM82633A004352")

    async def test_vin_rejects_symbols_and_overlong_values(self):
        for value in ("VIN<>", "X" * 25):
            with self.subTest(value=value):
                with self.assertRaises(ValidationError):
                    DeviceProfileIn(vin=value)

    async def test_profile_cannot_target_another_tenant(self):
        self.user.tenant_id = 3
        with self.assertRaises(HTTPException) as error:
            await update_device_profile(1, DeviceProfileIn(model="X"), self.db, self.user)
        self.assertEqual(error.exception.status_code, 403)
        self.db.commit.assert_not_awaited()


class RouteQueryTests(unittest.IsolatedAsyncioTestCase):
    async def test_route_is_built_from_column_rows(self):
        from datetime import datetime, timedelta
        from unittest.mock import patch
        from app.routers import positions as positions_router

        device_result = Mock()
        device_result.scalars.return_value.first.return_value = SimpleNamespace(id=1, tenant_id=2)
        base = datetime(2026, 10, 25, 8, 0, 0)
        rows = [
            SimpleNamespace(latitude=-17.8 + i * 0.009, longitude=31.03, speed=40.0,
                            timestamp=base + timedelta(seconds=30 * i), raw=None)
            for i in range(3)
        ]
        rows_result = Mock()
        rows_result.all.return_value = rows
        db = SimpleNamespace(execute=AsyncMock(side_effect=[device_result, rows_result]))
        user = SimpleNamespace(id=7, tenant_id=2)
        with patch.object(positions_router, "can_see_device", AsyncMock(return_value=True)):
            response = await positions_router.get_device_route(1, None, None, db, user)
        self.assertEqual(response["total_points"], 3)
        self.assertEqual([p["lat"] for p in response["points"]], [r.latitude for r in rows])
        self.assertTrue(all(p["timestamp"].endswith("Z") for p in response["points"]))
        self.assertGreater(response["total_distance_km"], 1.9)


if __name__ == "__main__":
    unittest.main()
