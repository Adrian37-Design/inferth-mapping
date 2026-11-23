"""Add activation_applied_at to manual_payments

Revision ID: d202611230001
Revises: c202611230001
Create Date: 2026-11-23

"""
from typing import Union
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'd202611230001'
down_revision: Union[str, None] = 'c202611230001'
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table('manual_payments', schema=None) as batch_op:
        batch_op.add_column(sa.Column('activation_applied_at', sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('manual_payments', schema=None) as batch_op:
        batch_op.drop_column('activation_applied_at')
