"""create tables

Revision ID: aaf548e60ea1
Revises: 
Create Date: 2025-11-19 19:01:22.040338

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'aaf548e60ea1'
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'tenants',
        sa.Column('id', sa.Integer, primary_key=True),
        sa.Column('name', sa.String, nullable=False, unique=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now())
    )

    op.create_table(
        'users',
        sa.Column('id', sa.Integer, primary_key=True),
        sa.Column('email', sa.String, unique=True, nullable=False),
        sa.Column('hashed_password', sa.String, nullable=False),
        sa.Column('is_admin', sa.Boolean, default=False),
        sa.Column('tenant_id', sa.Integer, sa.ForeignKey('tenants.id'))
    )

    op.create_table(
        'devices',
        sa.Column('id', sa.Integer, primary_key=True),
        sa.Column('imei', sa.String, unique=True, nullable=False),
        sa.Column('name', sa.String),
        sa.Column('tenant_id', sa.Integer, sa.ForeignKey('tenants.id')),
        sa.Column('device_metadata', sa.JSON, default={}),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now())
    )

    op.create_table(
        'positions',
        sa.Column('id', sa.Integer, primary_key=True),
        sa.Column('device_id', sa.Integer, sa.ForeignKey('devices.id')),
        sa.Column('latitude', sa.Float),
        sa.Column('longitude', sa.Float),
        sa.Column('altitude', sa.Float, nullable=True),
        sa.Column('speed', sa.Float, nullable=True),
        sa.Column('course', sa.Float, nullable=True),
        sa.Column('timestamp', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column('raw', sa.JSON, nullable=True)
    )

    op.create_table(
        'device_data',
        sa.Column('id', sa.Integer, primary_key=True),
        sa.Column('device_id', sa.String),
        sa.Column('timestamp', sa.DateTime, default=sa.func.now()),
        sa.Column('latitude', sa.Float),
        sa.Column('longitude', sa.Float),
        sa.Column('speed', sa.Float),
        sa.Column('status', sa.String)
    )

def downgrade() -> None:
    op.drop_table('device_data')
    op.drop_table('positions')
    op.drop_table('devices')
    op.drop_table('users')
    op.drop_table('tenants')