/** How an SMS campaign is labelled in lists when it is not given a name. */
export function campaignLabel(body: string): string {
  const oneLine = body.replace(/\s+/g, ' ').trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 79)}…` : oneLine;
}
