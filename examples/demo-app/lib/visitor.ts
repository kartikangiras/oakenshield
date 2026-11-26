const KEY = 'fp_vid';

/** The anonymous id used as the Flagsmith identity, before and after GitHub sign-in. */
export function getVisitorId(): string {
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  return id;
}

/** Whether this browser has been to FirstPR before. Sent as the visitor_type trait. */
export function isReturningVisitor(): boolean {
  return localStorage.getItem('fp_seen') === '1' || (localStorage.setItem('fp_seen', '1'), false);
}
