---
name: switzerland-parliament-guide
description: Use the chparl_* tools to research the Swiss Federal Assembly. Trace a business through committee, debate, and Nationalrat roll calls, establish what a member said or how they voted, or join a committee roster to a vote. Covers identifier routes, picking the right roll call, and the checks before reporting a vote, a speaker's position, or committee membership.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Use this guide when a question about the Swiss Federal Assembly needs more than one record: a business and its roll calls, a debate and its speakers, a committee and how its members voted. The server is keyless and reads Curia Vista business, the Amtliches Bulletin for both councils, Nationalrat member roll calls, members, current committee composition, and declared interests.

No tool returns popular-vote (referendum) results, enacted law text, cantonal parliaments, Ständerat member decisions, or past committee composition. Say so instead of inferring them.

## Identifiers

| ID | Comes from | Goes to |
|:--|:--|:--|
| `voteId` (Vote.ID) | `chparl_get_votes` votes mode; `voteId` on member-history rows | `chparl_get_votes` members and groups modes |
| Bulletin passage `voteId` | Vote-announcement passages in `chparl_search_transcripts` | Nothing directly; it is the roll call's `registrationNumber` (below) |
| `personNumber` | Member search and roster rows, debate passages, vote member rows | `chparl_get_member`, `chparl_get_votes`, `chparl_search_transcripts` |
| `committeeId` (CommitteeNumber) | `chparl_list_reference` topic committees; `committeeId` on `chparl_get_business` preconsultations rows and `chparl_get_member` committees rows | `chparl_search_members`, `chparl_search_business` |
| `groupId` (ParlGroupNumber) | `chparl_list_reference` topic groups | `chparl_search_members` |
| `subjectId` | `chparl_get_business` section subjects; `subjectId` on passages | `chparl_search_transcripts` |
| `sessionId` | `chparl_list_reference` topic sessions, filtered by dates | `chparl_get_votes`, `chparl_search_transcripts`, `chparl_search_business` |

- A passage's `voteId` is the roll call's `registrationNumber`, not its Vote.ID. The 13.468 final vote is Vote 25923, announced in the Bulletin as 22183. To reach the roll call, list votes mode for the passage's business and match `registrationNumber`. Passed to `chparl_get_votes` as `voteId`, it opens an unrelated roll call. Ständerat announcements carry a `voteId` with no roll call behind it.
- A `personNumber` on a passage or vote row opens `chparl_get_member` directly; no name search is needed. A Federal Council speaker's passages can carry one too.
- Each council has its own committee number (Legal Affairs is RK-N 12 and RK-S 25), and a sub-committee has its own number and roster. The committees dictionary is long and has no name filter, so when a business or member is already in hand, read the number off its preconsultations or committees rows.
- Vote rows carry a group code (`V`, `S`, `RL`), while `chparl_search_members` filters by numeric `groupId`. For current groups, topic groups maps one to the other: its `code` equals the vote row's code. Some codes on older rows (`C` on a 2017 roll call) have no entry there.
- A passage's own `businessId` is set only on vote announcements. Join other passages to business through `subjectId` and `subjectBusinesses`.

## Gates

- Search business titles in the source language. `chparl_search_business` `query` is a literal substring of the title in the selected metadata language: "marriage for all" matches nothing, "Ehe für alle" finds 13.468. A miss is not absence; try the French or Italian title, a shorter stem, or the type, author, or committee filters.
- Treat `chparl_search_business` `sessionId` as the submission session. 13.468 was submitted in session 4911; its roll calls fall in sessions 5009, 5104, and 5107. Find what happened in a session through `chparl_get_votes` votes mode or `chparl_search_transcripts` with that `sessionId`.
- Pick the roll call before reporting "the vote". Votes mode lists the business's Nationalrat roll calls newest first, and they come in several kinds: entry into the matter (Eintreten, entrer en matière), article votes between majority and minority proposals, the vote on the whole bill in that council (Gesamtabstimmung, vote sur l'ensemble), the final vote at the close of a session (Schlussabstimmung, vote final), and procedural votes such as a deadline extension. Read `subject`, `billTitle`, `meaningYes`, and `meaningNo` first, and name the roll call in the answer. These fields are stored as recorded, sometimes in French under `de` metadata.
- Read yes as the `meaningYes` proposal. On an article vote, yes usually backs the committee majority's wording, so a member's yes or no is support or opposition for that proposal, not for the bill.
- Report a tally, not an inferred outcome. No roll call states whether its proposal carried. Give the groups-mode counts with the meanings they decided between. The council's own published count is the vote-announcement passage (type 2) from that sitting; for the 13.468 final vote it reads 136 for, 48 against, 9 abstentions, matching groups mode.
- Never report a Ständerat member's vote. The Ständerat's tally exists only as its announcement passage (council `S`, type 2; 24 to 11 with 7 abstentions on the 13.468 final vote). A Ständerat member's stance comes only from what they said in debate.
- Check who is speaking. `speakerFunction` BR-F or BR-M marks a Federal Council member presenting the government's position, and P-F or P-M the presiding officer. Type 2 passages have no speaker and announce a vote.
- Write text queries in the language that was spoken. Passages stay in the speaker's language whatever the metadata language, so `query` finds only that wording: `mariage` on 13.468 in session 5104 returned French passages only. Repeat the query in each language speakers may have used, or drop it and scope by business, subject, and `personNumber`.
- Don't count from one page. Pages are fitted to a byte budget, so a page far below the limit with `hasMore: true` is routine: a request for 100 rows can return 9 passages or 22 roll-call rows. Before saying "only N", follow `nextOffset` or `nextCursor` to the end or use `totalCount` where it is present.
- Read a missing `subjectBusinesses` against the notices. A notice saying the lookup was unavailable means it failed and the field is omitted; retry the same call, since no other tool maps a `subjectId` to its business. With no such notice, no delivered passage carries a `subjectId`. An entry with `businesses: []` means none are published for that subject.
- Search former members with `membership: all`. The default `current` drops anyone who has left parliament. A surname `query` also matches compound surnames, so confirm the `personNumber` before reading a profile.
- Don't present today's committee as the committee that handled a past business. The roster and a member's committees section both list current memberships only; a former member's committees section is empty.
- Check group labels before reporting how a group voted on an older roll call. Rows can carry a group name adopted later, and one group can be split across codes: a June 2017 roll call shows `C` CVP-Fraktion (22 rows) beside `M-E` "Die Mitte-Fraktion. Die Mitte. EVP." (8 rows), a group that did not exist under that name until 2021. Name the group as it was then, and say when its rows are split.
- Compare statuses by name across the 1 July 2023 change. Codes below 200 are the earlier vocabulary and 2xx the current one, and one business's status history can mix both (13.468: 24, 1, 2, 4, then 229). Compare `statusName`; topic statuses tags each code's `era`.

## Workflows

### Business to votes and debate

1. Resolve the business by title wording, or pass a known short number such as `13.468` straight to `chparl_get_business`.
2. Section preconsultations names the committees that examined it, status_history its procedural steps, and bills the drafts that a roll call's `billNumber` refers to.
3. List roll calls in votes mode, choose one under the gates, and read its tally in groups mode. For one member's record across the business, use members mode with that `personNumber` and the `businessId`.
4. For the debate, search transcripts by `businessId`. Narrow to the sitting of a roll call with `dateFrom` and `dateTo` set to the date of its `endTime`; the type 2 passage whose `voteId` equals the roll call's `registrationNumber` carries the published count. A business with more than 20 debate subjects fails as `business_scope_too_broad`: page section subjects and search one `subjectId` at a time.

### A committee and a vote

1. Get the committee number (Identifiers), then page the roster to its end with `chparl_search_members` `committeeId` (current members only, so leave `membership` at `current`). `committeeFound: false` marks an unknown number; an existing committee with no published members returns `committeeFound: true` and no rows.
2. For a few members, call members mode once per `personNumber` with the `businessId`. For a whole committee on one roll call, page that roll call in members mode and join its rows to the roster on `personNumber`.
3. Ständerat committee members have no roll calls; use their debate passages.
4. State that the roster is the current composition when the business is older.

### What a member said

1. Resolve the `personNumber`, with `membership: all` if they may have left. `chparl_get_member` section council_terms holds the earlier terms a search row does not show.
2. When the topic maps to a business, search transcripts by its `businessId` or `subjectId` plus the `personNumber`. That needs no text query and has no date limit.
3. Otherwise run a text query per session or per window of at most 31 days, worded in the member's language; their passages' `languageOfText` shows it when published. Text searches can be slow, so keep windows narrow.
4. Read whole passages with `includeText` or an exact `transcriptId`, and join `subjectBusinesses` to name the business each passage belongs to.
