"""Add Honda Fit GP1 Hybrid CAN and OBD-II telemetry columns

Revision ID: b202611030101
Revises: aaf548e60ea1
Create Date: 2026-11-03 18:00:00.000000

"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b202611030101'
down_revision: Union[str, None] = 'aaf548e60ea1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

COLS = [
    # Dedicated CAN / OBD-II Telemetry
    ('fuel_level', sa.Float),
    ('rpm', sa.Integer),
    ('engine_temp', sa.Float),
    ('battery_voltage', sa.Float),
    ('odometer', sa.Float),
    ('ignition', sa.Boolean),
    ('dtc_fault_codes', sa.JSON),

    # Honda Fit GP1 Hybrid - Extended CAN & OBD-II Telemetry
    ('gear', sa.String),
    ('pedal_pct', sa.Integer),
    ('steering_deg', sa.Float),
    ('obd_speed', sa.Integer),

    # Wheel dynamics & safety
    ('ws_fl', sa.Float),
    ('ws_fr', sa.Float),
    ('ws_rl', sa.Float),
    ('ws_rr', sa.Float),
    ('traction_loss', sa.Boolean),
    ('brake_pressed', sa.Boolean),
    ('brake_bar', sa.Float),
    ('abs_active', sa.Boolean),
    ('lateral_g', sa.Float),
    ('yaw_rate', sa.Float),
    ('crash_flag', sa.Boolean),

    # IMA Hybrid system
    ('hybrid_soc', sa.Integer),
    ('motor_kw', sa.Float),
    ('inverter_temp', sa.Float),
    ('battery_temp', sa.Float),
    ('hybrid_auto_stop', sa.Boolean),

    # Fluids & active OBD
    ('cvt_fluid_temp', sa.Float),
    ('engine_load', sa.Float),
    ('map_kpa', sa.Integer),
    ('timing_advance', sa.Float),
    ('intake_temp', sa.Float),
    ('maf_gps', sa.Float),
    ('runtime_sec', sa.Integer),
    ('throttle_pct', sa.Float),
    ('battery_12v', sa.Float),
    ('oil_life_pct', sa.Integer),

    # Body, comfort & security
    ('door_driver', sa.Boolean),
    ('door_passenger', sa.Boolean),
    ('door_rear', sa.Boolean),
    ('trunk', sa.Boolean),
    ('seatbelt_unbuckled', sa.Boolean),
    ('handbrake', sa.Boolean),
    ('check_engine_mil', sa.Boolean),
    ('tpms_warning', sa.Boolean),
    ('ac_on', sa.Boolean),
    ('headlights', sa.Boolean),
    ('low_fuel', sa.Boolean),
]


def upgrade() -> None:
    for name, col_type in COLS:
        op.execute(f"ALTER TABLE positions ADD COLUMN IF NOT EXISTS {name} {col_type().compile(dialect=op.get_bind().dialect)} DEFAULT NULL")


def downgrade() -> None:
    for name, _ in COLS:
        op.drop_column('positions', name)
