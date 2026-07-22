# Liquidation Incident Alerts

## Goal

Treat repeated partial fills on one account-market pair as one liquidation incident, rather than creating a fresh Slack alert after every fill.

## Alert lifecycle

1. The first liquidatable observation opens an incident and sends the existing urgent alert with configured mentions.
2. The incident stays open while the position remains liquidatable, including after a protocol liquidation trade.
3. Partial fills are silent. At most once every 30 minutes, a non-mention progress update reports the current quantity and risk. It says `partial liquidation in progress` after a protocol fill, otherwise `liquidation risk persists`.
4. A terminal alert is sent only after the incident ends:
   - `Fully liquidated` when protocol liquidation trades occurred and no position remains.
   - `Risk cleared, position remains open` when the position is no longer liquidatable but remains open.
   - `Position closed by trader` when no protocol liquidation trade occurred and no position remains.

## Trade classification

The monitor will retain the IDs of observed trades for each incident. Indexer trades with `isLiquidation: true` are protocol liquidations. A non-liquidation trade that reduces the alerted side of the position is a trader-initiated reduction. The ETHFI incident that prompted this work contained at least 99 protocol liquidation trades and one small trader reduction.

## State and polling

Persist each incident's initial alert snapshot, the set of seen trade IDs, whether a protocol liquidation occurred, and its last progress-notification time in the existing alert-state file. The existing one-minute monitor cadence and trade query are unchanged.

## Verification

Tests will cover opening an incident, suppressing repeated partial-fill alerts, the 30-minute progress update, terminal classification, and trade-ID deduplication.
