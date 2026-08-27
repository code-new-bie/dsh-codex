export function foldDshSessionTitle(events = []) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'session/title') continue;
    const title = event.data?.title;
    if (typeof title === 'string' && title.length > 0) return title;
  }
  return null;
}

export function threadNameUpdatedNotification(threadId, title) {
  return {
    method: 'thread/name/updated',
    params: {
      threadId: String(threadId),
      threadName: title == null ? null : String(title)
    }
  };
}
