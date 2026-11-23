# Issue 52: pacing status clarity

Approved scope: distinguish pacing quality from receiver regulation and TCP-only events; clarify legend labels. No native transport, capture cadence, disk access, thread, timer or socket changes.

RED: two classifier regressions failed (receiver regulation returned Assessing; TCP-only activity returned Uneven). GREEN: all 12 targeted tests pass. TypeScript build and targeted lint pass. Browser QA passes 10 checks, including capture/freeze/close, toggle errors, narrow viewport, keyboard focus and hidden-window cancellation.

The existing 100 ms graph data and update cadence are retained. Legends now read Measured send rate, Intended send rate, Average track bitrate, and Excess delay ≥25 ms. The intended-rate legend explains delivery headroom. Unknown/new/stale observations still assess; actual scheduling/write stalls still warn. Receiver regulation is explained alongside steady pacing. Sustained delivery deficits with transport evidence still trigger Falling behind.

Packaging: rebuild the unified Windows suite, not just the desktop installer. User installation/playback verification remains pending; no merge or push is authorized.

Self-review: accuracy 4 (hardware behavior remains unverified), completeness 4 (user verification pending), clarity 5 (explicit legend names), actionability 5 (rebuilt installer), conciseness 5. Overall 4.6/5. Remaining improvement: verify the previously reported receiver-regulation case on the physical streamer.
