import asyncio
import json
import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Set

import websockets
from websockets.server import WebSocketServerProtocol

logging.basicConfig(level=logging.INFO, format="[%(asctime)s] %(levelname)s %(message)s")

PORT = int(os.environ.get("PORT", "8765"))
HOST = os.environ.get("HOST", "0.0.0.0")
DATA_DIR = Path(os.environ.get("DATA_DIR", Path(__file__).parent / "data"))

@dataclass
class Session:
    clients: Set[WebSocketServerProtocol] = field(default_factory=set)
    last_project: dict | None = None

sessions: Dict[str, Session] = {}


def safe_session_id(session_id: str) -> str:
    return "".join(c if c.isalnum() or c in "-_." else "_" for c in session_id) or "session"


def session_file(session_id: str) -> Path:
    return DATA_DIR / f"session-{safe_session_id(session_id)}.json"


def load_session_project(session_id: str) -> dict | None:
    path = session_file(session_id)
    if not path.exists():
        return None
    try:
        with path.open("r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as exc:
        logging.warning("Failed to load session file %s: %s", path, exc)
        return None


def save_session_project(session_id: str, project: dict):
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        path = session_file(session_id)
        tmp_path = path.with_suffix(".tmp")
        with tmp_path.open("w", encoding="utf-8") as f:
            json.dump(project, f, ensure_ascii=False)
        tmp_path.replace(path)
    except Exception as exc:
        logging.warning("Failed to save session %s: %s", session_id, exc)

async def send_json(ws: WebSocketServerProtocol, payload: dict):
    try:
        await ws.send(json.dumps(payload))
    except Exception as exc:
        logging.warning("Failed to send message: %s", exc)

async def broadcast(session_id: str, payload: dict, skip: WebSocketServerProtocol | None = None):
    session = sessions.get(session_id)
    if not session:
        return
    for client in list(session.clients):
        if client.closed:
            session.clients.discard(client)
            continue
        if skip and client is skip:
            continue
        await send_json(client, payload)

async def handler(ws: WebSocketServerProtocol):
    session_id = None
    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                logging.warning("Invalid JSON from %s", ws.remote_address)
                continue

            mtype = msg.get("type")
            session_id = msg.get("sessionId") or session_id
            client_id = msg.get("clientId")
            project = msg.get("project")

            if not session_id:
                await send_json(ws, {"type": "error", "message": "sessionId required"})
                continue

            session = sessions.setdefault(session_id, Session())
            session.clients.add(ws)

            # Lazy-load persisted snapshot if memory has none.
            if session.last_project is None:
                session.last_project = load_session_project(session_id)

            if mtype == "join":
                logging.info("Client %s joined session %s", client_id, session_id)
                if session.last_project:
                    await send_json(ws, {"type": "project_snapshot", "sessionId": session_id, "project": session.last_project})
                continue

            # Both "update_project" and "project_snapshot" carry the latest full state from a client.
            # Store it server-side and broadcast to other clients so late joiners and active peers stay in sync.
            if mtype in {"update_project", "project_snapshot"} and project:
                session.last_project = project
                save_session_project(session_id, project)
                await broadcast(session_id, {"type": "project_snapshot", "sessionId": session_id, "project": project}, skip=ws)
                continue

            if mtype == "ping":
                await send_json(ws, {"type": "pong"})
                continue

    except websockets.ConnectionClosed:
        pass
    finally:
        if session_id and session_id in sessions:
            sessions[session_id].clients.discard(ws)
            if not sessions[session_id].clients:
                sessions.pop(session_id, None)
        logging.info("Client %s disconnected from session %s", ws.remote_address, session_id)

async def main():
    async with websockets.serve(handler, HOST, PORT):
        logging.info("WS server listening on %s:%s", HOST, PORT)
        await asyncio.Future()  # run forever

if __name__ == "__main__":
    asyncio.run(main())
