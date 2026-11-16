/** strings.badges — every badge label (statuses and condition chips). */
export const en = {
  invitationStatus: {
    pending: 'Pending',
    accepted: 'Accepted',
    expired: 'Expired',
    revoked: 'Revoked',
  },
  accessRequestStatus: {
    pending: 'Pending',
    approved: 'Approved',
    rejected: 'Rejected',
  },
  system: 'System',
  systemTitle: "System roles can't be deleted",
  condition: {
    own: 'Own records',
    any: 'Any records',
    entity: 'Entity',
    department: 'Department',
    jobTitle: 'Job title',
    'self-approval': 'No self-approval',
  },
}

export const it: typeof en = {
  invitationStatus: {
    pending: 'In attesa',
    accepted: 'Accettato',
    expired: 'Scaduto',
    revoked: 'Revocato',
  },
  accessRequestStatus: {
    pending: 'In attesa',
    approved: 'Approvata',
    rejected: 'Rifiutata',
  },
  system: 'Di sistema',
  systemTitle: 'I ruoli di sistema non possono essere eliminati',
  condition: {
    own: 'Solo propri record',
    any: 'Tutti i record',
    entity: 'Società',
    department: 'Reparto',
    jobTitle: 'Qualifica',
    'self-approval': 'No auto-approvazione',
  },
}
