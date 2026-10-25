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

    async def test_profile_cannot_target_another_tenant(self):
        self.user.tenant_id = 3
        with self.assertRaises(HTTPException) as error:
            await update_device_profile(1, DeviceProfileIn(model="X"), self.db, self.user)
        self.assertEqual(error.exception.status_code, 403)
        self.db.commit.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
