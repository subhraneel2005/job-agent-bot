const chains = new Map<number, Promise<unknown>>();

export function enqueue<T>(chatId: number, task: () => Promise<T>): Promise<T> {
  const previous = chains.get(chatId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  chains.set(
    chatId,
    next.finally(() => {
      if (chains.get(chatId) === next) chains.delete(chatId);
    }) as Promise<unknown>
  );
  return next;
}

export function queueDepth(): number {
  return chains.size;
}
