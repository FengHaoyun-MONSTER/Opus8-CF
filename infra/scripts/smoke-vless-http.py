#!/usr/bin/env python3
"""End-to-end VLESS over XHTTP or gRPC smoke test using only stdlib."""

from __future__ import annotations

import argparse
import http.client
import re
import struct
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


def read_proxy_response(response: http.client.HTTPResponse, transport: str) -> bytes:
    wire = bytearray()
    for _ in range(64):
        chunk = response.read1(65536)
        if not chunk:
            break
        wire.extend(chunk)
        decoded = (
            unwrap_grpc_response(bytes(wire), allow_partial=True)
            if transport == "grpc"
            else bytes(wire)
        )
        if re.search(rb"HTTP/1\.[01] [1-5][0-9]{2}", decoded):
            return decoded
    return (
        unwrap_grpc_response(bytes(wire))
        if transport == "grpc"
        else bytes(wire)
    )


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

    connection = http.client.HTTPSConnection(
        parsed.hostname,
        parsed.port or 443,
        timeout=timeout,
    )
    try:
        connection.request(
            "POST",
            path,
            body=body,
            headers={
                "Content-Type": content_type,
                "Cache-Control": "no-store",
                "Connection": "close",
                "Referer": f"https://{parsed.hostname}/?x_padding=smoke",
            },
        )
        response = connection.getresponse()
        if response.status != 200:
            raise RuntimeError(f"{transport} endpoint returned HTTP {response.status}")
        received = read_proxy_response(response, transport)
    finally:
        connection.close()

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
