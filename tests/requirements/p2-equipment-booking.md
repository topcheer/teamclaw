# Product Requirement: Equipment Booking Hub

Build a complete internal equipment booking product for a small office team.

## Goal

Deliver a runnable web app that allows teammates to:

- browse bookable equipment such as meeting kits, cameras, and laptops
- reserve an item for a date range
- see booking conflicts and availability status
- mark an item as checked out or returned
- view a compact dashboard of active bookings and overdue returns

## Technical expectations

- moderate scope only: no SSO, no email, no external integrations
- use a lightweight backend service and a simple previewable UI
- use plain file-backed persistence (for example JSON) rather than SQLite
- avoid native addons or dependencies that require local compilation
- include clear run instructions and sample seeded data

## Quality expectations

- conflict rules for overlapping bookings must be handled correctly
- validation should cover missing fields and unavailable date ranges
- QA should verify the main workflow plus at least a few error cases

## Deliverables

- application source code
- setup and verification notes
- any simple tests or scripted checks that make the workflow reproducible
