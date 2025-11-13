# MCP backend code review

1. **Critical** – *src/appointment-booking.ts:69-90, src/membership-booking.ts:69-91, src/giftcard-purchase.ts:69-91* log the Basic Authorization header (authenticationHeader). That string is a Base64-encoded combo of API key and HMAC token, so every request currently writes long-lived credentials to stdout/stderr—any log sink (CloudWatch, Sentry, etc.) now contains production secrets. These logs need to be removed before shipping.

2. **High** – *src/chat/chat.service.ts:749-778* reinitializes userIntent to "membership" on every request and only re-detects intent when the conversation history is empty. After the very first user turn, all later OpenAI calls run with the membership-only tool set, so booking flows lose access to booking tools and will fail/misbehave as soon as the user sends a follow-up message.

3. **High** – *src/chat/chat.service.ts:732-741* lets pruneHistoryForState rebuild the system prompt using the latest free-form user utterance. Any short acknowledgement like “yes” or “sounds good” lacks the keywords your detector looks for, so the next turn resets the assistant to the “please choose booking or membership” onboarding prompt, derailing in-progress checkouts.

4. **High** – *src/chat/chat.service.ts:43-52* reads this.sessionState[sessionId].bookableTimeId before verifying that sessionState[sessionId] exists. If the token arrives after the session expired—or simply before any state was saved—the null dereference throws and the payment callback returns HTTP 500 instead of a user-facing error.

## Token Pressure Drivers

1. src/chat/chat.service.ts (lines 755-778) keeps every tool response in conversationHistory, including large GraphQL payloads. Tools like getLocations, availableServices, etc. stringify entire result sets, so dozens of kilobytes get re-sent to OpenAI each turn.

2. src/membership-booking.ts (lines 626-666), src/appointment-booking.ts (lines 1207-1414), 
src/giftcard-purchase.ts (lines 689-767) return full GraphQL documents without trimming. Those raw JSON blobs (all locations, services, staff, etc.) feed directly into chat history and dominate token usage.

3. The booking system prompt in buildSystemPrompt is ~400 lines long; the same verbose instructions are reinserted whenever history is pruned, so initial token count per call is already high.

4. pruneHistoryForState in src/chat/chat.service.ts (lines 708-744) only triggers after 20+ messages and only if it can extract key IDs. Until then, no truncation occurs, so long sessions accumulate unbounded state.

5. Tool executions log every result via console.log(JSON.stringify(result, null, 2)) (see src/chat/chat.service.ts (lines 816-820)). These logs aren’t sent to OpenAI but indicate the same large payloads being stored; if logging is disabled elsewhere, the payloads still persist in memory/history.

- **Recommendation**:

1. Strip heavy fields from tool outputs before pushing them into history (e.g., map to summarized lists).
2. Lower the prune threshold and ensure it always falls back to a concise state summary, even when some IDs are missing.
3. Shorten the system prompt—move long guidance into structured notes or external docs.


## Anomalies Detected

1. src/chat/chat.service.ts (line 43) this.sessionState[sessionId].bookableTimeId is read before verifying that this.sessionState[sessionId] exists, so an expired session triggers a runtime crash.

2. src/chat/chat.service.ts (lines 751-778) resets userIntent to "membership" on every request; after the first turn booking sessions run with the wrong tool set.

3. src/chat/chat.service.ts (lines 732-741) rebuilds the system prompt using only the latest user utterance; brief replies like “yes” wipe the established intent and force the flow back to the initial prompt.

4. src/membership-booking.ts (lines 69-91), src/appointment-booking.ts (lines 69-92), src/giftcard-purchase.ts (lines 69-92) log the base64-encoded authorization header, leaking production credentials into logs.

- **Recommendations**

1. Guard sessionState accesses or bail out cleanly when a session is missing.
2. Persist detected intent per session and reuse it after pruning.
3. Preserve module selection across short user confirmations.
4. Remove sensitive credential logging.

## Optimizations

1. src/chat/chat.service.ts (lines 775-819) – pre-sanitize tool results before pushing into conversationHistory; strip huge JSON payloads down to the fields the LLM needs (IDs, names) to keep token usage under control.

2. src/chat/chat.service.ts (lines 770-783) – cache the OpenAI client configuration and reuse a lighter system prompt; today each call ships a multi-hundred-line prompt that you could trim by moving long guidance to separate helper strings or feature flags.

3. src/chat/chat.service.ts (lines 816-820) – stop logging entire MCP responses; logging tens of kilobytes per tool call hammers stdout and blocks the event loop, so keep just concise metadata.

4. src/chat/chat.service.ts (lines 704-741) – lower the pruning threshold and emit a small, fixed-format state summary even if some IDs are missing; waiting for 20 messages lets token count balloon.

5. src/chat/booking-flow.service.ts (lines 11-18) – replace the ad hoc sessionState object with a scoped class or Nest provider and add expiry; serializing/deserialize state cleanly will simplify future concurrency and reduce leak risk.

## Constatnts in code

1. src/chat/chat.service.ts (line 925) hardcodes the checkout redirect to https://blvd-chatbot.ostlive.com/checkout.... That domain should come from an env var (e.g. CHECKOUT_BASE_URL) so you can swap between staging/prod without code changes.

2. The commented examples in src/appointment-booking.ts (lines 24-26), src/membership-booking.ts (lines 24-26), and src/giftcard-purchase.ts (lines 24-26) embed actual Boulevard API credentials. Even though they’re commented out, they shouldn’t live in source—load those values exclusively from environment or secrets management.