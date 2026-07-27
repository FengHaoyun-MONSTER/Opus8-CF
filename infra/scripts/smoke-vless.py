#!/usr/bin/env python3
"""End-to-end VLESS-over-WebSocket smoke test using only the Python stdlib."""

from __future__ import annotations

import argparse
import base64
import hashlib
import os
import socket
import ssl
import struct
import sys
import uuid
from urllib.parse import urlsplit


def recv_exact(sock: ssl.SSLSocket, count: int) -> bytes:
    out = bytearray()
    while len(out) < count:
        chunk = sock.recv(count - len(out))
        if not chunk:
            raise RuntimeError("unexpected EOF")
        out.extend(chunk)
    return bytes(out)


def send_ws_frame(sock: ssl.SSLSocket, payload: bytes, opcode: int = 2) -> None:
    mask = os.urandom(4)
    length = len(payload)
    header = bytearray([0x80 | opcode])
    if length < 126:
        header.append(0x80 | length)
    elif length <= 0xFFFF:
        header.append(0x80 | 126)
        header.extend(struct.pack("!H", length))
    else:
        header.append(0x80 | 127)
        header.extend(struct.pack("!Q", length))
    header.extend(mask)
    masked = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
    sock.sendall(bytes(header) + masked)


def recv_ws_frame(sock: ssl.SSLSocket) -> tuple[int, bytes]:
    first, second = recv_exact(sock, 2)
    opcode = first & 0x0F
    length = second & 0x7F
    if length == 126:
        length = struct.unpack("!H", recv_exact(sock, 2))[0]
    elif length == 127:
        length = struct.unpack("!Q", recv_exact(sock, 8))[0]
    mask = recv_exact(sock, 4) if second & 0x80 else b""
    payload = recv_exact(sock, length)
    if mask:
        payload = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
    return opcode, payload


def websocket_upgrade(sock: ssl.SSLSocket, host: str, path: str) -> None:
    key = base64.b64encode(os.urandom(16)).decode("ascii")
    request = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {host}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n\r\n"
    ).encode("ascii")
    sock.sendall(request)
    response = bytearray()
    while b"\r\n\r\n" not in response and len(response) < 32768:
        chunk = sock.recv(4096)
        if not chunk:
            break
        response.extend(chunk)
    status = bytes(response).split(b"\r\n", 1)[0]
    if b" 101 " not in status:
        raise RuntimeError(f"websocket upgrade failed: {status.decode('ascii', 'replace')}")
    expected = base64.b64encode(
        hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest()
    ).lower()
    if expected not in bytes(response).lower():
        raise RuntimeError("invalid Sec-WebSocket-Accept")


def build_vless_packet(user_uuid: str, target: str = "example.com", port: int = 80) -> bytes:
    domain = target.encode("idna")
    http = f"GET / HTTP/1.1\r\nHost: {target}\r\nConnection: close\r\n\r\n".encode("ascii")
    return (
        b"\x00"
        + uuid.UUID(user_uuid).bytes
        + b"\x00"  # additional information length
        + b"\x01"  # TCP command
        + struct.pack("!H", port)
        + b"\x02"  # domain address type
        + bytes([len(domain)])
        + domain
        + http
    )


def run(url: str, user_uuid: str, timeout: float) -> None:
    parsed = urlsplit(url)
    if parsed.scheme != "wss" or not parsed.hostname:
        raise ValueError("--url must be a wss:// URL")
    host = parsed.hostname
    port = parsed.port or 443
    path = parsed.path or "/"
    if parsed.query:
        path += "?" + parsed.query

    context = ssl.create_default_context()
    with socket.create_connection((host, port), timeout=timeout) as raw:
        with context.wrap_socket(raw, server_hostname=host) as sock:
            sock.settimeout(timeout)
            websocket_upgrade(sock, host, path)
            send_ws_frame(sock, build_vless_packet(user_uuid))

            received = bytearray()
            for _ in range(16):
                opcode, payload = recv_ws_frame(sock)
                if opcode == 8:
                    raise RuntimeError("server closed before VLESS response")
                if opcode == 9:
                    send_ws_frame(sock, payload, opcode=10)
                    continue
                if opcode in (0, 2):
                    received.extend(payload)
                if b"HTTP/1.1 200" in received:
                    break

    if len(received) < 2 or received[:2] != b"\x00\x00":
        raise RuntimeError("invalid VLESS response header")
    if b"HTTP/1.1 200" not in received:
        raise RuntimeError("egress HTTP probe did not return 200")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--uuid", required=True)
    parser.add_argument("--timeout", type=float, default=20.0)
    args = parser.parse_args()
    try:
        run(args.url, args.uuid, args.timeout)
    except Exception as exc:
        print(f"vless smoke failed: {exc}", file=sys.stderr)
        return 1
    print("vless smoke ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
