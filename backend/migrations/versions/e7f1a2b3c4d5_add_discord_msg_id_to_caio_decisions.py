"""Add discord_message_id + discord_channel_id to caio_event_decisions.

Fase A of the Discord-as-action layer (#caio-aprovacoes): when Pedro reacts
on a Caio proposal post in Discord, the listener bot writes the decision
into ``caio_event_decisions`` with the originating message_id + channel_id.
The Cockpit UI uses those fields to render a "Decidido no Discord" badge
linking back to the post, replacing the in-app Approve/Reject buttons.

Both columns stay NULL for decisions made directly in the Cockpit UI
(backward compatible).

Revision ID: e7f1a2b3c4d5
Revises: d3e4f5a6b7c8
Create Date: 2026-05-24 16:00:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "e7f1a2b3c4d5"
down_revision = "d3e4f5a6b7c8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "caio_event_decisions",
        sa.Column("discord_message_id", sa.Text(), nullable=True),
    )
    op.add_column(
        "caio_event_decisions",
        sa.Column("discord_channel_id", sa.Text(), nullable=True),
    )
    op.create_index(
        "ix_caio_event_decisions_discord_message_id",
        "caio_event_decisions",
        ["discord_message_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_caio_event_decisions_discord_message_id",
        table_name="caio_event_decisions",
    )
    op.drop_column("caio_event_decisions", "discord_channel_id")
    op.drop_column("caio_event_decisions", "discord_message_id")
