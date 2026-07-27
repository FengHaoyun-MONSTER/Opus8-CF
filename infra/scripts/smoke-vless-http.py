#!/usr/bin/env python3
"""End-to-end VLESS over XHTTP or gRPC smoke test using only stdlib."""

from __future__ import annotations

import argparse
import re
import struct
import subprocess
import sys
import uuid
from urllib.parse import urlsplit


def build_vless_packet(user_uuid: str, target: str, port: int) -> bytes:
    domain = target.encode("idna")
    http = (
        f"GET / HTTP/1.1\r\nHost: {target}\r\nConnection: close\r\n\r\n"
    ).encode("ascii")
    return (
        b"\x00"
        + uuid.UUID(user_uuid).bytes
        + b"\x00"
        + b"\x01"
        + struct.pack("!H", port)
        + b"\x02"
        + bytes([len(domain)])
        + domain
        + http
    )


def grpc_request_frame(payload: bytes) -> bytes:
    return b"\x00" + struct.pack("!I", len(payload)) + payload


def read_varint(payload: bytes, offset: int) -> tuple[int, int]:
    value = 0
    shift = 0
    while offset < len(payload) and shift <= 35:
        current = payload[offset]
        offset += 1
        value |= (current & 0x7F) << shift
        if current & 0x80 == 0:
            return value, offset
        shift += 7
    raise RuntimeError("invalid protobuf varint")


def unwrap_grpc_response(body: bytes, allow_partial: bool = False) -> bytes:
    output = bytearray()
    offset = 0
    while offset + 5 <= len(body):
        compressed = body[offset]
        frame_length = struct.unpack("!I", body[offset + 1 : offset + 5])[0]
        offset += 5
        if compressed != 0:
            raise RuntimeError("invalid gRPC response frame")
        if offset + frame_length > len(body):
            if allow_partial:
                offset -= 5
                break
            raise RuntimeError("invalid gRPC response frame")
        frame = body[offset : offset + frame_length]
        offset += frame_length
        if frame.startswith(b"\x0a"):
            chunk_length, chunk_offset = read_varint(frame, 1)
            chunk = frame[chunk_offset : chunk_offset + chunk_length]
            if len(chunk) != chunk_length:
                raise RuntimeError("truncated protobuf response chunk")
            output.extend(chunk)
        else:
            output.extend(frame)
    if not allow_partial and offset != len(body):
        raise RuntimeError("trailing bytes in gRPC response")
    return bytes(output)


def request_http2(
    url: str,
    body: bytes,
    content_type: str,
    timeout: float,
) -> tuple[int, bytes]:
    marker = b"\nOPUS8_HTTP_STATUS:"
    result = subprocess.run(
        [
            "curl",
            "--http2",
            "--silent",
            "--show-error",
            "--no-buffer",
            "--fail-with-body",
            "--max-time",
            str(timeout),
            "-X",
            "POST",
            "-H",
            f"Content-Type: {content_type}",
            "-H",
            "Cache-Control: no-store",
            "-H",
            f"Referer: {url}?x_padding=smoke",
            "--data-binary",
            "@-",
            "--write-out",
            "\\nOPUS8_HTTP_STATUS:%{http_code}\\n",
            url,
        ],
        input=body,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    marker_offset = result.stdout.rfind(marker)
    if marker_offset < 0:
        detail = result.stderr.decode("utf-8", "replace").strip()
        raise RuntimeError(
            f"curl HTTP/2 probe failed with exit {result.returncode}: {detail}"
        )
    status_text = result.stdout[marker_offset + len(marker) :].strip()
    status = int(status_text)
    response_body = result.stdout[:marker_offset]
    # curl 28 is acceptable only when the bidirectional stream intentionally stays
    # open after a complete proxy response; payload validation below remains strict.
    if result.returncode not in (0, 28) and status == 0:
        detail = result.stderr.decode("utf-8", "replace").strip()
        raise RuntimeError(f"curl HTTP/2 probe failed: {detail}")
    return status, response_body


def run(
    url: str,
    transport: str,
    user_uuid: str,
    timeout: float,
    target: str,
    target_port: int,
    expect_status: int,
) -> None:
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise ValueError("--url must be an https:// URL")
    path = parsed.path or f"/{transport}"
    if parsed.query:
        path += "?" + parsed.query
    packet = build_vless_packet(user_uuid, target, target_port)
    if transport == "grpc":
        body = grpc_request_frame(packet)
        content_type = "application/grpc"
    else:
        body = packet
        content_type = "application/octet-stream"

    endpoint = f"https://{parsed.hostname}:{parsed.port}{path}" if parsed.port else (
        f"https://{parsed.hostname}{path}"
    )
    status, response_body = request_http2(endpoint, body, content_type, timeout)
    if status != 200:
        raise RuntimeError(f"{transport} endpoint returned HTTP {status}")
    received = (
        unwrap_grpc_response(response_body, allow_partial=True)
        if transport == "grpc"
        else response_body
    )

    if len(received) < 2 or received[:2] != b"\x00\x00":
        raise RuntimeError("invalid VLESS response header")
    match = re.search(rb"HTTP/1\.[01] ([1-5][0-9]{2})", received)
    if not match:
        raise RuntimeError("egress HTTP probe did not return an HTTP response")
    actual_status = int(match.group(1))
    if expect_status and actual_status != expect_status:
        raise RuntimeError(
            f"egress HTTP probe returned {actual_status}, expected {expect_status}"
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--transport", choices=("xhttp", "grpc"), required=True)
    parser.add_argument("--uuid", required=True)
    parser.add_argument("--timeout", type=float, default=25.0)
    parser.add_argument("--target", default="example.com")
    parser.add_argument("--target-port", type=int, default=80)
    parser.add_argument("--expect-status", type=int, default=200)
    args = parser.parse_args()
    try:
        run(
            args.url,
            args.transport,
            args.uuid,
            args.timeout,
            args.target,
            args.target_port,
            args.expect_status,
        )
    except Exception as exc:
        print(f"{args.transport} smoke failed: {exc}", file=sys.stderr)
        return 1
    print(f"{args.transport} smoke ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
