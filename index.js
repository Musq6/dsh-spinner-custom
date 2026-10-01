/**
 * Host half of the spinner-custom bundle.
 *
 * This bundle does no Host-side work at all. Both halves of what it does are
 * browser-side: it restyles one element the Web page already renders, and it
 * contributes a row to Settings -> General whose value is a client preference.
 * Neither has anything the Host process needs to know about, so there is no
 * Config schema here and no settings namespace to serve — which is also why the
 * row persists through the client store in localStorage rather than through
 * `ctx.configForms`.
 *
 * The export form still has to be a valid plugin because the patch row resolves
 * this package's `.` entry.
 */
export function apply() {}
