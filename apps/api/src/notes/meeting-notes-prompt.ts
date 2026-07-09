/** Shared extraction rules for meeting notes (reasoning + Ax paths). */
export const MEETING_NOTES_EXTRACTION_RULES = `
You are extracting meeting notes from a transcript. Optimize for EXECUTION, not completeness.

## Summary
- 3–5 sentences max.
- Capture the main topics and outcomes only.

## Goals (metrics & targets — NOT action items)
- Baseline targets, thresholds, and success criteria discussed in the meeting.
- Use precise metric language from the transcript:
  - "Critical + High findings" and "Critical findings" — do NOT say "false positives" unless the speaker explicitly means false positives.
  - Example: "Scan all 350 Java repositories" is a goal, not an action item.
- Max 6 goals. No duplicates.

## Action items (this week / immediate)
- Max 12 items. Prefer 6–10 for a standup.
- Each item must be a concrete deliverable someone can do — start with a verb.
- Assign owner when a person is named or clearly implied (use their name). Otherwise use "Team".
- Merge related steps into ONE item (e.g. chunk runs 20–25 repos AND stop after 5 open tickets = one item).
- Do NOT list goals, decisions, or long-term roadmap work here.
- Do NOT split one assignment into multiple bullets.
- Include ticket IDs and numbers exactly when mentioned (e.g. ticket 172).

## Roadmap (later / not immediate)
- Future or multi-sprint work explicitly discussed but not assigned for this week.
- Examples: nightly CSV regression runs, full workflow harness, expanding to 1000 repos.
- Max 8 items.

## Decisions
- Firm agreements and direction — not tasks.
- Max 8. Do NOT repeat goals or action items verbatim.

## Open questions
- Unresolved items only. Max 6.

## Deduplication
- The same fact must appear in only ONE section.
- If something is a goal, it must not also be an action item or decision.
`.trim();
