// Message shown to the user for a backend error { code, subject, message }: the translation of the
// code when there is one, otherwise the English message of the backend.

import { t } from '../i18n/i18n.js';

export function describeError(error) {
  if (typeof error === 'string') return error;
  const key = `errors.${error?.code}`;
  const text = t(key, { subject: error?.subject ?? '', message: error?.message ?? '' });
  return text === key ? (error?.message ?? String(error)) : text;
}
