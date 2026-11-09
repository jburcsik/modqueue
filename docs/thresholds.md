# Thresholds and defaults

Every value below is the public default in `src/config.ts` (`defaultConfig`).
The defaults are illustrative. They are not the values any live deployment
runs; a host loads its own values into `ModerationConfig` before launch and
edits the same literals in `supabase/migrations/0001_modqueue.sql` where the
SQL copy of a table exists. Fields marked structural are not tunables.

Step tables (`StepTable`) are piecewise lookups: rows are checked in order,
the first row whose `below` exceeds the input wins, and `otherwise` applies
when none does.

## trust

Account-age tiers and the reputation boost and restriction applied on top.

| Field | Default | What it does |
|---|---|---|
| `tiers[0]` | `new`: below 48 h, cannot report, 2 submissions per day, requires approval | First tier; `requiresApproval` holds every new submission and opens a case. |
| `tiers[1]` | `restricted`: below 168 h, can report, 4 per day, requires approval | Second tier. |
| `tiers[2]` | `limited`: below 336 h, can report, 8 per day, no approval | Third tier. |
| `tiers[3]` | `full`: no upper age, can report, 16 per day, no approval | Final tier; `maxAgeHours` is null. |
| `boostAt` | 70 | Reputation score at or above which the daily cap is multiplied and approval is lifted, except for the first tier. |
| `boostMultiplier` | 2 | Multiplier applied to the daily cap on boost. |
| `boostCap` | 30 | Upper bound on the boosted daily cap. |
| `restrictAt` | 30 | Reputation score at or below which the daily cap is divided and approval is forced. |
| `restrictDivisor` | 2 | Divisor applied to the daily cap on restriction. |
| `restrictFloor` | 2 | Lower bound on the restricted daily cap. |

## reputation

A score from the host's `moderation_reputation_inputs` view row.

| Field | Default | What it does |
|---|---|---|
| `baseline` | 40 | Score every user starts from. |
| `endorsedPostWeight` | 3 | Points added per endorsed post. |
| `endorsedPostCap` | 24 | Most points endorsed posts can add. |
| `endorsementGivenWeight` | 0.5 | Points added per endorsement given. |
| `endorsementGivenCap` | 10 | Most points endorsements given can add. |
| `postWeight` | 1 | Points added per post. |
| `postCap` | 12 | Most points posts can add. |
| `reportReceivedWeight` | 4 | Points subtracted per report received in state `upheld`. |
| `reportReceivedCap` | 32 | Most points reports received can subtract. |
| `min` | 0 | Structural: lower bound of the score. |
| `max` | 100 | Structural: upper bound of the score. |

## reach

The reach coefficient is the product of five factors, clamped. It scales
report trust weight, content lifetime and notification fan-out.

| Field | Default | What it does |
|---|---|---|
| `enabled` | true | When false, `computeReach` returns coefficient 1.0 with every factor 1.0. |
| `clamp` | min 0, max 1.5 | Structural: coefficient bounds. |
| `unknownUserCoefficient` | 0.5 | Coefficient when the reputation view has no row for the user. |
| `age` | below 48 h: 0.5; below 168 h: 0.75; below 336 h: 0.9; otherwise 1.0 | Factor by account age in hours. |
| `reputation` | below 25: 0.4; below 40: 0.6; below 55: 0.8; below 70: 1.0; below 85: 1.1; otherwise 1.15 | Factor by reputation score. |
| `strikes` | below 1: 1.0; below 4: 0.75; below 6: 0.45; below 8: 0.15; otherwise 0.1 | Factor by active strike points. |
| `engagement.bonusMinEndorsedPosts` | 8 | With no reports received, this many endorsed posts or more earns `bonusFactor`. |
| `engagement.bonusFactor` | 1.1 | Engagement factor on bonus. |
| `engagement.neutralRatio` | 2 | Endorsed posts divided by reports received above this ratio is neutral (1.0); below it is `penaltyFactor`. |
| `engagement.penaltyFactor` | 0.85 | Engagement factor on penalty. |
| `farReport` | below 0.25: 1.0; below 0.5: 0.4; otherwise 0.1 | Factor by `far_rate`; a null `far_rate` is 1.0. |
| `ttl.floorMultiplier` | 0.3 | Lowest multiplier `applyReachToTtl` applies to the base lifetime. |
| `ttl.ceilingMultiplier` | 1.4 | Highest multiplier `applyReachToTtl` applies to the base lifetime. |
| `notification.steps` | below 0.15: no notice, radius 0; below 0.35: notice, radius 0.3; below 0.65: notice, radius 0.6; below 1.05: notice, radius 1.0 | Notification policy by coefficient. |
| `notification.radiusCap` | 1.25 | Upper bound on the radius multiplier above the last step. |
| `visibilityFloor` | 0.15 | Below this coefficient content is visible only to its owner; enforced by the host's read path. |

## strikes

| Field | Default | What it does |
|---|---|---|
| `weights.info` | 1 point, decays after 60 days | Strike weight for `info` severity. |
| `weights.warning` | 2 points, decays after 60 days | Strike weight for `warning`. |
| `weights.violation` | 3 points, decays after 60 days | Strike weight for `violation`. |
| `weights.severe` | 5 points, never decays | Strike weight for `severe`; `decayDays` is null. |
| `ladder.nudge` | 2 | Active points at which the `nudge` tier begins; `clean` is below it. |
| `ladder.warned` | 4 | Active points at which `warned` begins. |
| `ladder.reviewGated` | 6 | Active points at which `review_gated` begins; also the release point written on `tier_hold` events. |
| `ladder.quieted` | 8 | Active points at which `quieted` begins. |
| `pointsMin` | 1 | Structural: lower bound of the CHECK on `user_strikes.points`. |
| `pointsMax` | 5 | Structural: upper bound of that CHECK. |

## scoring

| Field | Default | What it does |
|---|---|---|
| `severeCategories` | `sexual/minors`, `self-harm/intent`, `violence/graphic` | Structural: provider category names that hold regardless of thresholds. |
| `severeScoreFloor` | 0.4 | Score strictly above which a severe category holds. |
| `allowLogFloor` | 0.2 | Max score at or above which an allow is logged as `allow_log`. |

## automation

| Field | Default | What it does |
|---|---|---|
| `fullAutoRemoveFloor` | 0.95 | `full_auto` removes a hold-tier submission only at or above the larger of this and `settings.autoActionConfidence`. |
| `automatedActorLabel` | `Automated review` | Label shown for the `automated` actor in audit summaries and the reference admin. |

## rateLimits

Sliding windows per user, counted in `internal.rate_limit_entries`.

| Field | Default | What it does |
|---|---|---|
| `submit` | 6 per 60 s | Content writes. |
| `read` | 60 per 60 s | Queue and log reads. |
| `report` | 5 per hour | Reports; must equal `settings.reportRateMax` and `settings.reportRateWindowSeconds`. |
| `appeal` | 3 per day | Appeals; must equal `settings.appealRateMax` and `settings.appealRateWindowSeconds`. |
| `signupHourly` | 5 per hour | Sign-ups. |
| `signupDaily` | 20 per day | Sign-ups. |
| `bypass` | false | When true every check returns allowed. Set explicitly, never from the environment. |

## filter

| Field | Default | What it does |
|---|---|---|
| `blockedTerms` | empty | Lowercase substrings that block a submission. An empty example list; a host supplies its own. |
| `profilingPhrases` | empty | Patterns that block with a coaching message. An empty example list. |
| `blockedTermsMessage` | `This text contains language that is not allowed here.` | Message returned on a blocked term. |
| `profilingMessage` | `Describe what the person is doing rather than how they look.` | Message returned on a profiling phrase. |
| `piiPatterns` | `phone`, `email`, `id_number`, `licence_plate` | Patterns that warn without blocking. |
| `minLengthChars` | 12 | Cleaned text shorter than this adds a warning. |

## tripwire

| Field | Default | What it does |
|---|---|---|
| `patterns` | English and French patterns named `ignore_instructions`, `disregard_above`, `forget_instructions`, `override_system`, `new_instructions`, `you_are_now`, `act_as`, `pretend_to_be`, `developer_mode`, `no_restrictions`, `system_tag`, `chat_markup`, `end_of_prompt`, `instead_of`, `your_real_task`, `print_prompt`, `reveal_prompt`, `what_are_your_instructions` | Detect only; a hit writes a `tripwire` event and never blocks. |

## reports

| Field | Default | What it does |
|---|---|---|
| `reasonMaxChars` | 500 | Longest reason accepted. |
| `maxEvidencePaths` | 2 | Most evidence paths per report. |
| `evidencePathPattern` | segments of letters, digits, dot, underscore and hyphen joined by single slashes; must start with a letter or digit; no `.` or `..` segment, no leading, trailing or doubled slash | Shape check on each path; paths are opaque storage keys and the kit signs nothing. |
| `evidencePathMaxChars` | 255 | Longest path accepted. |

## appeals

| Field | Default | What it does |
|---|---|---|
| `statementMinChars` | 10 | Shortest statement accepted; the CHECK on `moderation_appeals.statement` uses the same bound. |
| `statementMaxChars` | 1000 | Longest statement accepted. |

## messages

| Field | Default | What it does |
|---|---|---|
| `brandName` | unset | Inserted into stock copy when set; copy reads "this community" otherwise. |

## top level

| Field | Default | What it does |
|---|---|---|
| `userLookupDebounceMs` | 1800000 (30 min) | Identical `user_lookup` events by the same actor within this window are not written again. |

## settings

The single admin-editable row in `moderation_settings`. The migration's
column defaults equal these values.

| Field | Default | What it does |
|---|---|---|
| `automationLevel` | `assist` | One of `off`, `assist`, `semi_auto`, `full_auto`. |
| `warnThreshold` | 0.5 | Max category score at or above which a submission is warned. |
| `holdThreshold` | 0.8 | Max category score at or above which a submission is held. |
| `autoActionConfidence` | 0.75 | Confidence floor below which automated actions become shadow logs. |
| `autoWarnKeywords` | empty | Keywords that warn. An empty example list. |
| `autoBlockKeywords` | empty | Keywords that block. An empty example list. |
| `fullAutoAcknowledgedAt` | null | Must be set before `automationLevel` may be `full_auto` (CHECK in SQL). |
| `autoHideWeight` | 3.5 | Sum of open reports' trust weight at or above which content is auto-held. |
| `reportMinAccountAgeHours` | 48 | Account age below which `file_report` refuses with `account_too_new`. |
| `reportRateMax` | 5 | Reports allowed per window. |
| `reportRateWindowSeconds` | 3600 | Report rate window. |
| `appealRateMax` | 3 | Appeals allowed per window. |
| `appealRateWindowSeconds` | 86400 | Appeal rate window. |
| `reportIdentityRetentionDays` | 60 | Days after resolution before `purge_report_identities` nulls `reporter_id`. |
| `reachEnabled` | true | When false, SQL reach returns 1.0 and reports carry trust weight 1.0. |
| `updatedAt` | null | Set by the store on save. |
| `updatedBy` | null | Set by the store on save. |
