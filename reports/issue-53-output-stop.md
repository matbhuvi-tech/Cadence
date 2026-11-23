# Issue 53: output scan disabled after desktop restart

Read-only inspection of the running Windows Engine confirmed playback activity `paused`, owner `core`, position 27.3 seconds, and system-default output. Restarting the Desktop did not stop this independently running playback session. The output dialog disabled discovery and output changes for non-idle activity but provided no Stop control.

Added an explicit user-triggered Stop playback button to the dialog. It sends the existing coreStop command, refreshes the authoritative snapshot, and verifies idle before reporting success. Pause-lock and 30-second discovery cooldown are explained. No automatic stop, discovery, new polling, timers, socket changes or native audio code was introduced.

Validation: TypeScript build passes; all 32 core-service regression tests pass; diff whitespace check passes. The installed dialog interaction and physical renderer discovery remain for user verification. No claim of browser or hardware validation is made for this specific control.

Audiophile impact: no added library disk reads, unsolicited network discovery, workers, hot-path allocations or native scheduling changes. The new IPC calls occur only when the user clicks Stop. Existing native cooldown remains authoritative.

Self-review: accuracy 4 (live paused state confirmed, installed interaction pending); completeness 4 (user hardware verification pending); clarity 5 (explicit recovery control); actionability 5 (installer and steps); conciseness 5. Overall 4.6/5. Remaining improvement is user validation of Stop, cooldown and scan on the renderer.
