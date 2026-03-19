from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from threading import Lock
from typing import Any, Dict, List, Optional, Sequence

from .common import AgentConfig, ensure_parent, json_dumps, now_iso

class JsonlStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = Lock()

    def read_all(self) -> List[Dict[str, Any]]:
        with self.lock:
            if not self.path.exists():
                return []
            rows: List[Dict[str, Any]] = []
            for line in self.path.read_text(encoding="utf-8", errors="ignore").splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    value = json.loads(line)
                except Exception:
                    continue
                if isinstance(value, dict):
                    rows.append(value)
            return rows

    def write_all(self, records: Sequence[Dict[str, Any]]) -> None:
        with self.lock:
            ensure_parent(self.path)
            if not records:
                if self.path.exists():
                    self.path.unlink(missing_ok=True)
                return
            text = "\n".join(json_dumps(item) for item in records) + "\n"
            self.path.write_text(text, encoding="utf-8")

    def append(self, record: Dict[str, Any]) -> None:
        with self.lock:
            ensure_parent(self.path)
            with self.path.open("a", encoding="utf-8") as handle:
                handle.write(json_dumps(record))
                handle.write("\n")


def _clean_str(value: Any, max_len: int = 120) -> Optional[str]:
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    return text[:max_len]


def _clean_str_list(value: Any, max_len: int = 12) -> Optional[List[str]]:
    if not isinstance(value, list):
        return None
    items: List[str] = []
    seen: set[str] = set()
    for raw in value:
        text = _clean_str(raw, 80)
        if not text or text in seen:
            continue
        seen.add(text)
        items.append(text)
        if len(items) >= max_len:
            break
    return items or None


class ProfileMemoryStore:
    def __init__(self, config: AgentConfig) -> None:
        self.config = config
        self.store = JsonlStore(config.profile_memory_path)

    @staticmethod
    def _scope_key(scope: str, tenant_id: Optional[str], user_id: Optional[str], session_id: Optional[str]) -> str:
        if scope == "global":
            return "global"
        if scope == "tenant":
            if not tenant_id:
                raise ValueError("tenant scope requires tenantId")
            return f"tenant:{tenant_id}"
        if scope == "user":
            if not user_id:
                raise ValueError("user scope requires userId")
            return f"user:{tenant_id}:{user_id}" if tenant_id else f"user:{user_id}"
        if scope == "session":
            if not session_id:
                raise ValueError("session scope requires sessionId")
            if tenant_id and user_id:
                return f"session:{tenant_id}:{user_id}:{session_id}"
            if tenant_id:
                return f"session:{tenant_id}:{session_id}"
            if user_id:
                return f"session:{user_id}:{session_id}"
            return f"session:{session_id}"
        raise ValueError(f"unsupported scope: {scope}")

    @staticmethod
    def _normalize_profile(value: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "assistantDisplayName": _clean_str(value.get("assistantDisplayName"), 80),
            "assistantAliases": _clean_str_list(value.get("assistantAliases"), 10),
            "userPreferredName": _clean_str(value.get("userPreferredName"), 80),
            "language": _clean_str(value.get("language"), 24),
            "stylePreferences": _clean_str_list(value.get("stylePreferences"), 12),
        }

    @staticmethod
    def _merge(base: Dict[str, Any], patch: Dict[str, Any]) -> Dict[str, Any]:
        next_value = dict(base)
        for key in [
            "assistantDisplayName",
            "assistantAliases",
            "userPreferredName",
            "language",
            "stylePreferences",
        ]:
            if key not in patch:
                continue
            raw = patch.get(key)
            if raw is None:
                next_value.pop(key, None)
                continue
            if key in {"assistantAliases", "stylePreferences"}:
                cleaned = _clean_str_list(raw, 12)
            elif key == "language":
                cleaned = _clean_str(raw, 24)
            else:
                cleaned = _clean_str(raw, 80)
            if cleaned is None:
                next_value.pop(key, None)
            else:
                next_value[key] = cleaned
        return self._normalize_profile(next_value)

    def _records(self) -> List[Dict[str, Any]]:
        records = self.store.read_all()
        normalized: List[Dict[str, Any]] = []
        for item in records:
            scope = _clean_str(item.get("scope"), 24)
            if scope not in {"global", "tenant", "user", "session"}:
                continue
            scope_id = _clean_str(item.get("scopeId"), 200)
            if not scope_id:
                continue
            profile = self._normalize_profile(item.get("profile", {}))
            if not any(profile.values()):
                continue
            normalized.append(
                {
                    "id": _clean_str(item.get("id"), 200) or f"profile-{scope_id}",
                    "scope": scope,
                    "scopeId": scope_id,
                    "tenantId": _clean_str(item.get("tenantId"), 80),
                    "userId": _clean_str(item.get("userId"), 80),
                    "sessionId": _clean_str(item.get("sessionId"), 120),
                    "profile": profile,
                    "version": max(1, int(item.get("version", 1))),
                    "createdAt": _clean_str(item.get("createdAt"), 40) or now_iso(),
                    "updatedAt": _clean_str(item.get("updatedAt"), 40) or now_iso(),
                    "updatedBy": _clean_str(item.get("updatedBy"), 120) or "system",
                    "lastConfirmedAt": _clean_str(item.get("lastConfirmedAt"), 40),
                }
            )
        by_scope: Dict[str, Dict[str, Any]] = {}
        for item in normalized:
            previous = by_scope.get(item["scopeId"])
            if not previous:
                by_scope[item["scopeId"]] = item
                continue
            prev_ver = int(previous.get("version", 0))
            curr_ver = int(item.get("version", 0))
            if curr_ver >= prev_ver:
                by_scope[item["scopeId"]] = item
        return sorted(by_scope.values(), key=lambda it: str(it.get("scopeId")))

    def _persist(self, records: Sequence[Dict[str, Any]]) -> None:
        self.store.write_all(list(records))

    def get_effective(
        self, tenant_id: Optional[str], user_id: Optional[str], session_id: Optional[str]
    ) -> Dict[str, Any]:
        records = self._records()
        by_id = {item["scopeId"]: item for item in records}
        chain = ["global"]
        if tenant_id:
            chain.append(self._scope_key("tenant", tenant_id, None, None))
        if user_id:
            chain.append(self._scope_key("user", tenant_id, user_id, None))
        if session_id:
            chain.append(self._scope_key("session", tenant_id, user_id, session_id))
        resolved_records = [by_id[key] for key in chain if key in by_id]
        merged: Dict[str, Any] = {}
        for record in resolved_records:
            merged = self._merge(merged, record["profile"])
        latest = resolved_records[-1] if resolved_records else None
        return {
            "profile": merged,
            "records": resolved_records,
            "version": int(latest.get("version", 0)) if latest else 0,
            "updatedAt": latest.get("updatedAt") if latest else "",
            "updatedBy": latest.get("updatedBy") if latest else "",
            "lastConfirmedAt": latest.get("lastConfirmedAt") if latest else None,
        }

    def get_by_scope(
        self,
        scope: str,
        tenant_id: Optional[str],
        user_id: Optional[str],
        session_id: Optional[str],
    ) -> Dict[str, Any]:
        if scope == "effective":
            return self.get_effective(tenant_id, user_id, session_id)
        key = self._scope_key(scope, tenant_id, user_id, session_id)
        records = self._records()
        target = next((item for item in records if item["scopeId"] == key), None)
        if not target:
            return {
                "profile": {},
                "records": [],
                "version": 0,
                "updatedAt": "",
                "updatedBy": "",
                "lastConfirmedAt": None,
            }
        return {
            "profile": dict(target["profile"]),
            "records": [target],
            "version": target["version"],
            "updatedAt": target["updatedAt"],
            "updatedBy": target["updatedBy"],
            "lastConfirmedAt": target.get("lastConfirmedAt"),
        }

    def upsert(
        self,
        scope: str,
        tenant_id: Optional[str],
        user_id: Optional[str],
        session_id: Optional[str],
        patch: Dict[str, Any],
        updated_by: str,
    ) -> Dict[str, Any]:
        key = self._scope_key(scope, tenant_id, user_id, session_id)
        records = self._records()
        index = next((idx for idx, item in enumerate(records) if item["scopeId"] == key), -1)
        current = records[index] if index >= 0 else None
        merged = self._merge(dict(current["profile"]) if current else {}, patch)
        if not any(merged.values()):
            if index >= 0:
                del records[index]
                self._persist(records)
            return {
                "id": current["id"] if current else f"profile-{key}",
                "scope": scope,
                "scopeId": key,
                "version": int(current["version"]) if current else 0,
                "profile": {},
            }
        record = {
            "id": current["id"] if current else f"profile-{key}",
            "scope": scope,
            "scopeId": key,
            "tenantId": tenant_id,
            "userId": user_id,
            "sessionId": session_id,
            "profile": merged,
            "version": (int(current["version"]) if current else 0) + 1,
            "createdAt": current["createdAt"] if current else now_iso(),
            "updatedAt": now_iso(),
            "updatedBy": _clean_str(updated_by, 120) or "system",
            "lastConfirmedAt": now_iso(),
        }
        if index >= 0:
            records[index] = record
        else:
            records.append(record)
        self._persist(records)
        return record


class EpisodicMemoryStore:
    def __init__(self, config: AgentConfig) -> None:
        self.config = config
        self.store = JsonlStore(config.episodic_memory_path)

    def _records(self) -> List[Dict[str, Any]]:
        records = self.store.read_all()
        valid: List[Dict[str, Any]] = []
        for item in records:
            item_id = _clean_str(item.get("id"), 80)
            user_id = _clean_str(item.get("userId"), 80)
            content = _clean_str(item.get("content"), 2000)
            if not item_id or not user_id or not content:
                continue
            created_at = _clean_str(item.get("createdAt"), 40) or now_iso()
            valid.append(
                {
                    "id": item_id,
                    "userId": user_id,
                    "tenantId": _clean_str(item.get("tenantId"), 80),
                    "sessionId": _clean_str(item.get("sessionId"), 120),
                    "title": _clean_str(item.get("title"), 120) or "Conversation Memory",
                    "content": content,
                    "createdAt": created_at,
                    "tier": _clean_str(item.get("tier"), 24) or "working",
                    "importance": float(item.get("importance", 0.5)),
                    "reinforcedCount": int(item.get("reinforcedCount", 1)),
                    "lastAccessAt": _clean_str(item.get("lastAccessAt"), 40) or created_at,
                    "lastReinforcedAt": _clean_str(item.get("lastReinforcedAt"), 40) or created_at,
                    "tags": item.get("tags", []) if isinstance(item.get("tags"), list) else [],
                }
            )
        return valid

    def _persist(self, records: Sequence[Dict[str, Any]]) -> None:
        self.store.write_all(list(records))

    def capture(
        self,
        prompt: str,
        reply: str,
        user_id: str,
        tenant_id: Optional[str],
        session_id: Optional[str],
        citations: Sequence[str],
    ) -> Dict[str, Any]:
        if not self.config.rag_memory_enabled:
            return {"captured": False, "reason": "memory disabled"}
        text = f"Prompt: {prompt.strip()}\nReply: {reply.strip()}"
        text = text.strip()
        if len(text) < 24:
            return {"captured": False, "reason": "content too short"}
        records = self._records()
        dedup_key = hash_text(f"{user_id}|{tenant_id or ''}|{session_id or ''}|{text[:240]}")
        existing = next((item for item in records if item["id"].endswith(dedup_key[:10])), None)
        if existing:
            existing["reinforcedCount"] = int(existing.get("reinforcedCount", 1)) + 1
            existing["lastAccessAt"] = now_iso()
            existing["lastReinforcedAt"] = now_iso()
            self._persist(records)
            return {"captured": True, "id": existing["id"], "mode": "reinforce"}

        record = {
            "id": f"mem-{int(time.time() * 1000)}-{dedup_key[:10]}",
            "userId": user_id,
            "tenantId": tenant_id,
            "sessionId": session_id,
            "title": (prompt.strip()[:36] + "...") if len(prompt.strip()) > 36 else prompt.strip(),
            "content": text,
            "createdAt": now_iso(),
            "tier": "episodic" if citations else "working",
            "importance": clamp(0.35 + min(len(prompt) + len(reply), 1400) / 2200, 0.2, 0.95),
            "reinforcedCount": 1,
            "lastAccessAt": now_iso(),
            "lastReinforcedAt": now_iso(),
            "tags": [],
        }
        records.append(record)
        max_total = max(300, self.config.rag_memory_retention_days * 50)
        if len(records) > max_total:
            records = sorted(records, key=lambda it: str(it.get("lastAccessAt", "")), reverse=True)[:max_total]
        self._persist(records)
        return {"captured": True, "id": record["id"], "mode": "append"}

    def list(
        self,
        scope: str,
        tenant_id: Optional[str],
        user_id: Optional[str],
        session_id: Optional[str],
        limit: int,
    ) -> List[Dict[str, Any]]:
        records = self._records()

        def allowed(item: Dict[str, Any]) -> bool:
            if scope == "tenant":
                return bool(tenant_id) and item.get("tenantId") == tenant_id
            if scope == "session":
                return (
                    bool(session_id)
                    and item.get("sessionId") == session_id
                    and (not tenant_id or item.get("tenantId") == tenant_id)
                    and (not user_id or item.get("userId") == user_id)
                )
            return (not user_id or item.get("userId") == user_id) and (
                not tenant_id or item.get("tenantId") == tenant_id
            )

        filtered = [item for item in records if allowed(item)]
        filtered.sort(key=lambda it: str(it.get("createdAt", "")), reverse=True)
        return filtered[: max(1, min(limit, 200))]

    def delete(
        self,
        record_id: str,
        scope: str,
        tenant_id: Optional[str],
        user_id: Optional[str],
        session_id: Optional[str],
    ) -> Dict[str, Any]:
        records = self._records()
        removed = 0
        next_records: List[Dict[str, Any]] = []
        for item in records:
            if item.get("id") != record_id:
                next_records.append(item)
                continue
            scope_ok = False
            if scope == "tenant":
                scope_ok = bool(tenant_id) and item.get("tenantId") == tenant_id
            elif scope == "session":
                scope_ok = bool(session_id) and item.get("sessionId") == session_id
            else:
                scope_ok = (not user_id or item.get("userId") == user_id) and (
                    not tenant_id or item.get("tenantId") == tenant_id
                )
            if scope_ok:
                removed += 1
                continue
            next_records.append(item)
        if removed > 0:
            self._persist(next_records)
            return {"deleted": True, "removed": removed}
        return {"deleted": False, "removed": 0, "reason": "not found in scope"}


