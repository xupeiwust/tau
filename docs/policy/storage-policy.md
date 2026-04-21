---
title: 'Storage Policy'
description: 'Rules for atomic read-modify-write semantics, field-scoped patches, and concurrent-writer safety in client-side persistent storage providers (IndexedDB, OPFS, etc.).'
status: active
created: '2026-04-20'
updated: '2026-04-20'
related:
  - docs/policy/xstate-policy.md
  - docs/policy/filesystem-policy.md
  - docs/policy/testing-policy.md
  - docs/research/chat-draft-resurrection-race.md
---

# Storage Policy

Internal reference for how persistent storage providers (`IndexedDbStorageProvider`, future OPFS/Worker-OPFS variants, anything implementing the `StorageProvider` contract in `apps/ui/app/types/storage.types.ts`) must guarantee atomicity, isolation, and last-writer-wins semantics for the rows they manage.

## Rationale

Two independent XState actors (`persistDraftActor`, `persistMessagesActor`) used to share `IndexedDbStorageProvider.updateChat`, which performed `getChat → deepmerge → put` across two separate IndexedDB transactions with no per-`chatId` lock. When the user sent a message, the two writers raced and the message-pipeline writer's `getChat` could land inside the gap between the draft-pipeline writer's read and write, snapshotting a stale `draft` and re-saving the just-sent text. On reload, the previously sent message reappeared in the composer. See `docs/research/chat-draft-resurrection-race.md` for the full timeline.

This policy locks the fix in and prevents the same shape of bug recurring in future storage primitives or new fields on `Chat`/`Project`.

## Rules

### 1. Read-modify-write must be a single transaction

Every storage method that performs `read → mutate → write` against a single logical row must execute the read and write inside one transaction (or whatever isolation primitive the backing store provides). Resolve the outer `Promise` from `transaction.oncomplete`, never from `request.onsuccess`, so callers never observe a value before durability.

**Why**: Splitting the read and write across two IndexedDB transactions opens a window in which another writer can land a `put`, which is then silently overwritten when the first writer commits its stale-merged row.

CORRECT:

```typescript
return new Promise((resolve, reject) => {
  const transaction = db.transaction(this.chatsStoreName, 'readwrite');
  const store = transaction.objectStore(this.chatsStoreName);
  let resolved: Chat | undefined;

  const getRequest = store.get(chatId);
  getRequest.onsuccess = () => {
    const existingChat = getRequest.result as Chat | undefined;
    if (!existingChat) return;
    const next = mutate(existingChat);
    const putRequest = store.put(next);
    putRequest.onsuccess = () => {
      resolved = next;
    };
  };

  transaction.oncomplete = () => {
    db.close();
    resolve(resolved);
  };
});
```

INCORRECT:

```typescript
const existing = await this.getChat(chatId);
if (!existing) return undefined;
const next = mutate(existing);
const db = await this.getDb();
return new Promise((resolve, reject) => {
  const transaction = db.transaction(this.chatsStoreName, 'readwrite');
  transaction.objectStore(this.chatsStoreName).put(next);
  transaction.oncomplete = () => resolve(next);
});
```

### 2. Per-row in-process serialisation

Every mutating method must funnel through a per-row keyed mutex (`apps/ui/app/db/keyed-mutex.ts`) before opening its transaction. Two concurrent callers for the same `chatId`/`projectId` must execute in submission order; concurrent callers for different keys must run in parallel.

**Why**: Defence in depth on top of rule 1. Some backends (in-memory mocks, future remote sync workers, cross-tab proxies) cannot rely on transactional isolation alone. The mutex also gives `CrossTabCoordinator` and any future invalidation channel a single chokepoint.

CORRECT:

```typescript
public async updateChat(chatId: string, update: PartialDeep<Chat>): Promise<Chat | undefined> {
  return this.mutex.run(chatId, async () => this.updateChatAtomic(chatId, update));
}
```

INCORRECT:

```typescript
public async updateChat(chatId: string, update: PartialDeep<Chat>): Promise<Chat | undefined> {
  return this.updateChatAtomic(chatId, update);
}
```

### 3. Prefer field-scoped helpers over partial merges

For every named slot on `Chat`/`Project` that is updated by more than one writer, expose a field-scoped helper (`patchChat`, `setMessageEdit`, `clearMessageEdit`, `softDeleteChat`, …) and call that from production code. Reserve `updateChat`/`updateProject` for the full-row replacement path.

**Why**: A partial-merge writer reads the entire row and re-`put`s the entire row. Even with rule 1, the call site is still expressing "I read everything, I write everything", which makes future fields silently vulnerable as soon as a second writer appears. Field-scoped helpers make the blast radius equal to the named slot.

CORRECT:

```typescript
await patchChat(input.chatId, 'draft', input.draft);
await setMessageEdit(input.chatId, input.messageId, input.draft);
await clearMessageEdit(input.chatId, input.messageId);
```

INCORRECT:

```typescript
await updateChat(input.chatId, { draft: input.draft }, { ignoreKeys: ['draft'] });
await updateChat(input.chatId, { messageEdits: { [input.messageId]: input.draft } });
```

### 4. No `ignoreKeys` / `customMerge` escape hatches

Storage methods must not expose `ignoreKeys`, `customMerge`, or any other "skip the deep merge for this field" knob. If a caller needs target-wins semantics, they must either replace the full row (and own that responsibility) or call a field-scoped helper.

**Why**: `ignoreKeys` solves a merge-shape problem; it does not solve a transactional-isolation problem. Allowing it tempts callers to think "I added the key to ignoreKeys so I'm safe", which is exactly the bug pattern the policy exists to prevent.

INCORRECT:

```typescript
updateChat(
  chatId: string,
  update: PartialDeep<Chat>,
  options?: { ignoreKeys?: string[]; noUpdatedAt?: boolean },
): Promise<Chat | undefined>;
```

### 5. Bump `updatedAt` only on real mutations

Field-scoped helpers must skip the `updatedAt` bump when the mutation is a no-op (e.g. clearing an entry that does not exist). The `atomicChatMutation` helper expresses this with a `(chat) => boolean` mutator: returning `false` means "nothing changed".

**Why**: `updatedAt` drives sort order in the chat list and React Query invalidation. A no-op clear should not reorder the list.

CORRECT:

```typescript
this.atomicChatMutation(chatId, (chat) => {
  if (!chat.messageEdits || !(messageId in chat.messageEdits)) return false;
  delete chat.messageEdits[messageId];
  return true;
});
```

### 6. Concurrent regression coverage is mandatory for new fields

When a new field is added to `Chat`/`Project` and is written by more than one actor or hook, add a concurrency regression test in `apps/ui/app/db/indexeddb-storage.test.ts` that fires both writers `Promise.all`-style for at least 100 iterations against a fresh row and asserts every writer's last-written value is preserved.

**Why**: The original draft-resurrection bug was timing-dependent and a single-shot test passed by luck. The 100+-iteration loop is the only reliable way to expose the race in a deterministic test runner.

Reference template:

```typescript
for (let i = 0; i < iterations; i++) {
  const text = `iter-${i}`;
  await Promise.all([
    provider.patchChat(chat.id, 'draft', draftMessage(text)),
    provider.patchChat(chat.id, 'messages', [userMessage(text)]),
  ]);
  const final = await provider.getChat(chat.id);
  expect(final?.draft).toMatchObject({ parts: [{ type: 'text', text }] });
  expect(final?.messages[0]?.parts[0]).toEqual({ type: 'text', text });
}
```

### 7. Hooks invalidate React Query after every mutation

Every hook wrapper around a storage mutation (`useChats`, `useProjects`, `useProjectManager`) must call `queryClient.invalidateQueries` for both the collection key (`['chats', resourceId]` / `['projects']`) and the row key (`['chat', chatId]` / `['project', projectId]`) inside the same `useCallback` body. Field-scoped helpers must not skip invalidation just because the touched field is "small".

**Why**: Storage atomicity is necessary but not sufficient — the UI cache must converge to the new value or the user sees a stale row in the list.

CORRECT:

```typescript
const patchChat = useCallback(
  async <K extends keyof Chat>(chatId: string, key: K, value: Chat[K]) => {
    const updated = await patchChatInManager(chatId, key, value);
    void queryClient.invalidateQueries({ queryKey: ['chats', resourceId] });
    void queryClient.invalidateQueries({ queryKey: ['chat', chatId] });
    return updated;
  },
  [patchChatInManager, queryClient, resourceId],
);
```

## Anti-Patterns

- Calling `await getChat(id)` followed by `await updateChat(id, mutated)` from a hook or actor. Use a field-scoped helper instead — the manual `read → mutate → write` re-introduces the original race even though the storage layer is now atomic.
- Adding a new option flag to `updateChat`/`updateProject` to "preserve" or "skip" a field. Add a field-scoped helper instead.
- Wrapping `provider.updateChat` in `Promise.all([...])` in production code without confirming each writer touches a disjoint slot. Concurrent writers to the same slot must agree on a last-writer-wins serialisation point upstream.
- Mocking `IndexedDbStorageProvider` in unit tests instead of using the real provider with `fake-indexeddb/auto`. The race shows up in the real provider, not in mocks.

## Decision Table: which API to use

| Scenario                                       | API to call                                                  |
| ---------------------------------------------- | ------------------------------------------------------------ |
| Single top-level field on a chat               | `patchChat(chatId, key, value)`                              |
| Single entry in `chat.messageEdits`            | `setMessageEdit(chatId, messageId, draft)`                   |
| Remove a single entry in `chat.messageEdits`   | `clearMessageEdit(chatId, messageId)`                        |
| Soft-delete a chat                             | `softDeleteChat(chatId)` (`deleteChat` forwards to this)     |
| Full chat replacement (e.g. import, duplicate) | `updateChat(chatId, fullChat)` with `fullChat.id === chatId` |
| Single project field                           | `updateProject(projectId, { field: value })`                 |
| Full project replacement                       | `updateProject(projectId, fullProject)` with matching id     |

## Summary Checklist

Before merging a storage-layer change:

- [ ] Read and write happen inside one transaction; outer promise resolves on `transaction.oncomplete`.
- [ ] All public mutators go through `KeyedMutex.run(rowId, …)`.
- [ ] New multi-writer fields have field-scoped helpers, not extra `updateChat` options.
- [ ] No `ignoreKeys`/`customMerge` knob is reintroduced.
- [ ] `updatedAt` bumps only when the mutator returns `true`.
- [ ] A concurrency regression test in `apps/ui/app/db/indexeddb-storage.test.ts` covers the new field with ≥100 iterations.
- [ ] React Query invalidation hits both collection and row keys.

## References

- Research: `docs/research/chat-draft-resurrection-race.md`
- Implementation: `apps/ui/app/db/indexeddb-storage.ts`, `apps/ui/app/db/keyed-mutex.ts`
- Contract: `apps/ui/app/types/storage.types.ts`
- Hook surfaces: `apps/ui/app/hooks/use-chats.ts`, `apps/ui/app/hooks/use-project-manager.tsx`, `apps/ui/app/hooks/use-chat.tsx`
- Related: `docs/policy/xstate-policy.md`, `docs/policy/filesystem-policy.md`, `docs/policy/testing-policy.md`
