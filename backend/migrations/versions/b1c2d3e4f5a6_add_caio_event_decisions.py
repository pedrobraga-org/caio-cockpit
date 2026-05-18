"""Add caio_event_decisions table for Cockpit mark_only verdicts.

Revision ID: b1c2d3e4f5a6
Revises: a9b1c2d3e4f7
Create Date: 2026-05-18 14:10:00.000000

"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "b1c2d3e4f5a6"
down_revision = "a9b1c2d3e4f7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Create the caio_event_decisions table."""
    op.create_table(
        "caio_event_decisions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("event_id", sa.String(), nullable=False),
        sa.Column("decision", sa.String(), nullable=False),
        sa.Column(
            "decided_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("decided_by_user_id", sa.Uuid(), nullable=False),
        sa.Column("note", sa.String(), nullable=True),
        sa.ForeignKeyConstraint(
            ["decided_by_user_id"],
            ["users.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("event_id", name="uq_caio_event_decisions_event_id"),
    )
    op.create_index(
        "ix_caio_event_decisions_event_id",
        "caio_event_decisions",
        ["event_id"],
    )
    op.create_index(
        "ix_caio_event_decisions_decided_by_user_id",
        "caio_event_decisions",
        ["decided_by_user_id"],
    )


def downgrade() -> None:
    """Drop the caio_event_decisions table."""
    op.drop_index(
        "ix_caio_event_decisions_decided_by_user_id",
        table_name="caio_event_decisions",
    )
    op.drop_index(
        "ix_caio_event_decisions_event_id",
        table_name="caio_event_decisions",
    )
    op.drop_table("caio_event_decisions")
