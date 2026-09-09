import { getDatabase } from "./config";

export type PersistedSessionStatus =
  | "starting"
  | "active"
  | "completed"
  | "completed_with_warnings"
  | "failed"
  | "interrupted";

export type PersistedLaneStatus = "pending" | "streaming" | "completed" | "failed" | "stopped";

export type SessionStartRecord = {
  id: string;
  startedAt: number;
  mode: "overlay" | "webapp";
  workspace: string;
  piProvider: string;
  piModel: string;
  appVersion: string;
};

export type SessionTurnRecord = {
  id: string;
  sessionId: string;
  sequence: number;
  submittedAt: number;
  updatedAt: number;
  completedAt?: number;
  promptText: string;
  manualText?: string;
  transcriptLines: string[];
  screenshotPaths: string[];
  quickAnswer: string;
  quickStatus: PersistedLaneStatus;
  quickError?: string;
  piAnswer: string;
  piStatus: PersistedLaneStatus;
  piError?: string;
};

export type SessionEventRecord = {
  sessionId: string;
  sequence: number;
  eventType: string;
  source?: string;
  turnId?: string;
  payload?: unknown;
  createdAt: number;
};

export type SavedSessionSummary = {
  id: string;
  started_at: number;
  ended_at: number | null;
  updated_at: number;
  status: PersistedSessionStatus;
  mode: "overlay" | "webapp";
  workspace: string;
  pi_provider: string;
  pi_model: string;
  pi_session_id: string | null;
  last_error: string | null;
};

export async function markUnfinishedSessionsInterrupted(at = Date.now()) {
  const db = await getDatabase();
  await db.execute(
    `UPDATE overlay_sessions
       SET status = 'interrupted', ended_at = COALESCE(ended_at, ?), updated_at = ?
     WHERE status IN ('starting', 'active')`,
    [at, at],
  );
}

export async function createSessionRecord(record: SessionStartRecord) {
  const db = await getDatabase();
  await db.execute(
    `INSERT INTO overlay_sessions (
       id, started_at, updated_at, status, mode, workspace,
       pi_provider, pi_model, app_version, snapshot_json
     ) VALUES (?, ?, ?, 'starting', ?, ?, ?, ?, ?, '{}')`,
    [
      record.id,
      record.startedAt,
      record.startedAt,
      record.mode,
      record.workspace,
      record.piProvider,
      record.piModel,
      record.appVersion,
    ],
  );
}

export async function checkpointSession(
  sessionId: string,
  status: PersistedSessionStatus,
  snapshot: unknown,
  turns: SessionTurnRecord[],
  options: { piSessionId?: string; lastError?: string; updatedAt?: number } = {},
) {
  const db = await getDatabase();
  const updatedAt = options.updatedAt ?? Date.now();
  await db.execute(
    `UPDATE overlay_sessions
        SET status = ?, updated_at = ?, pi_session_id = COALESCE(?, pi_session_id),
            snapshot_json = ?, last_error = ?
      WHERE id = ?`,
    [
      status,
      updatedAt,
      options.piSessionId || null,
      JSON.stringify(snapshot),
      options.lastError || null,
      sessionId,
    ],
  );
  for (const turn of turns) {
    await upsertTurn(db, turn);
  }
}

export async function appendSessionEvent(record: SessionEventRecord) {
  const db = await getDatabase();
  await db.execute(
    `INSERT OR IGNORE INTO overlay_session_events (
       session_id, sequence, event_type, source, turn_id, payload_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      record.sessionId,
      record.sequence,
      record.eventType,
      record.source || null,
      record.turnId || null,
      JSON.stringify(record.payload ?? {}),
      record.createdAt,
    ],
  );
}

export async function finishSessionRecord(
  sessionId: string,
  status: Extract<PersistedSessionStatus, "completed" | "completed_with_warnings" | "failed">,
  snapshot: unknown,
  turns: SessionTurnRecord[],
  lastError?: string,
  endedAt = Date.now(),
) {
  await checkpointSession(sessionId, status, snapshot, turns, {
    lastError,
    updatedAt: endedAt,
  });
  const db = await getDatabase();
  await db.execute(
    `UPDATE overlay_sessions SET ended_at = ?, updated_at = ? WHERE id = ?`,
    [endedAt, endedAt, sessionId],
  );
}

export async function listSavedSessions(limit = 100): Promise<SavedSessionSummary[]> {
  const db = await getDatabase();
  return db.select<SavedSessionSummary[]>(
    `SELECT id, started_at, ended_at, updated_at, status, mode, workspace,
            pi_provider, pi_model, pi_session_id, last_error
       FROM overlay_sessions
      ORDER BY started_at DESC
      LIMIT ?`,
    [Math.max(1, Math.min(1000, Math.floor(limit)))],
  );
}

export async function getSavedSession(sessionId: string) {
  const db = await getDatabase();
  const sessions = await db.select<Array<Record<string, unknown>>>(
    "SELECT * FROM overlay_sessions WHERE id = ?",
    [sessionId],
  );
  if (!sessions.length) return null;
  const turns = await db.select<Array<Record<string, unknown>>>(
    "SELECT * FROM overlay_turns WHERE session_id = ? ORDER BY turn_sequence ASC",
    [sessionId],
  );
  const events = await db.select<Array<Record<string, unknown>>>(
    "SELECT * FROM overlay_session_events WHERE session_id = ? ORDER BY sequence ASC",
    [sessionId],
  );
  return { session: sessions[0], turns, events };
}

async function upsertTurn(
  db: Awaited<ReturnType<typeof getDatabase>>,
  turn: SessionTurnRecord,
) {
  await db.execute(
    `INSERT INTO overlay_turns (
       id, session_id, turn_sequence, submitted_at, updated_at, completed_at,
       prompt_text, manual_text, transcript_json, screenshot_paths_json,
       quick_answer, quick_status, quick_error, pi_answer, pi_status, pi_error
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       updated_at = excluded.updated_at,
       completed_at = excluded.completed_at,
       prompt_text = excluded.prompt_text,
       manual_text = excluded.manual_text,
       transcript_json = excluded.transcript_json,
       screenshot_paths_json = excluded.screenshot_paths_json,
       quick_answer = excluded.quick_answer,
       quick_status = excluded.quick_status,
       quick_error = excluded.quick_error,
       pi_answer = excluded.pi_answer,
       pi_status = excluded.pi_status,
       pi_error = excluded.pi_error`,
    [
      turn.id,
      turn.sessionId,
      turn.sequence,
      turn.submittedAt,
      turn.updatedAt,
      turn.completedAt || null,
      turn.promptText,
      turn.manualText || null,
      JSON.stringify(turn.transcriptLines),
      JSON.stringify(turn.screenshotPaths),
      turn.quickAnswer,
      turn.quickStatus,
      turn.quickError || null,
      turn.piAnswer,
      turn.piStatus,
      turn.piError || null,
    ],
  );
}
