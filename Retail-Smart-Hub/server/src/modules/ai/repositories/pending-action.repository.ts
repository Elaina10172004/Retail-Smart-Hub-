import { db } from '../../../database/db';

export interface PendingActionRow {
  id: string;
  actionName: string;
  status: 'pending' | 'confirmed' | 'cancelled';
  createdBy: string;
  username: string;
  requiredPermission: string;
  payload: string;
  summary: string;
  confirmationMessage: string;
  createdAt: string;
  expiresAt: string;
  undoSupported: number;
  executionResult: string | null;
  undoneAt: string | null;
}

function rowSelectSql() {
  return `
    SELECT
      id,
      action_name as actionName,
      status,
      created_by as createdBy,
      username,
      required_permission as requiredPermission,
      payload,
      summary,
      confirmation_message as confirmationMessage,
      created_at as createdAt,
      expires_at as expiresAt,
      undo_supported as undoSupported,
      execution_result as executionResult,
      undone_at as undoneAt
    FROM ai_pending_actions
  `;
}

export function getPendingActionRow(id: string) {
  return db.prepare<PendingActionRow>(`${rowSelectSql()} WHERE id = ?`).get(id);
}

export function findReusablePendingAction(actionName: string, createdBy: string, payloadJson: string, nowIso: string) {
  return db.prepare<PendingActionRow>(`
    ${rowSelectSql()}
    WHERE action_name = ?
      AND created_by = ?
      AND status = 'pending'
      AND payload = ?
      AND expires_at >= ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(actionName, createdBy, payloadJson, nowIso);
}

export function insertPendingAction(input: {
  actionId: string;
  actionName: string;
  userId: string;
  username: string;
  requiredPermission: string;
  payloadJson: string;
  summary: string;
  confirmationMessage: string;
  createdAt: string;
  expiresAt: string;
}) {
  db.prepare(
    `INSERT INTO ai_pending_actions (
      id, action_name, status, created_by, username, required_permission, payload, summary, confirmation_message, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.actionId,
    input.actionName,
    'pending',
    input.userId,
    input.username,
    input.requiredPermission,
    input.payloadJson,
    input.summary,
    input.confirmationMessage,
    input.createdAt,
    input.expiresAt,
  );
}

export function markPendingActionCancelled(actionId: string, cancelledAt: string) {
  db.prepare(`UPDATE ai_pending_actions SET status = 'cancelled', cancelled_at = ? WHERE id = ? AND status = 'pending'`).run(
    cancelledAt,
    actionId,
  );
}

export function markPendingActionConfirmed(input: {
  actionId: string;
  confirmedAt: string;
  undoSupported: number;
  executionResultJson: string | null;
}) {
  db.prepare(`
    UPDATE ai_pending_actions
    SET status = ?, confirmed_at = ?, executed_at = ?, undo_supported = ?, execution_result = ?
    WHERE id = ?
  `).run('confirmed', input.confirmedAt, input.confirmedAt, input.undoSupported, input.executionResultJson, input.actionId);
}

export function markPendingActionUndone(actionId: string, undoneAt: string) {
  db.prepare('UPDATE ai_pending_actions SET undone_at = ? WHERE id = ?').run(undoneAt, actionId);
}
