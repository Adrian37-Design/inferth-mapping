"""Add package fields to manual_payments (num_vehicles, package_tier, payment_plan)

Revision ID: c202611230001
Revises: b202611030101
Create Date: 2026-11-23

"""
from typing import Union
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'c202611230001'
down_revision: Union[str, None] = 'b202611030101'
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table('manual_payments', schema=None) as batch_op:
        batch_op.add_column(sa.Column('num_vehicles', sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column('package_tier', sa.String(length=50), nullable=True))
        batch_op.add_column(sa.Column('payment_plan', sa.String(length=50), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('manual_payments', schema=None) as batch_op:
        batch_op.drop_column('payment_plan')
        batch_op.drop_column('package_tier')
        batch_op.drop_column('num_vehicles')
