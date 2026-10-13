"""Encrypted at-rest storage for Random Studio output images."""

from __future__ import annotations

import mimetypes
import os
import re
import shutil
import stat
import uuid
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


MAGIC = b"ANIMAIMG1"
NONCE_BYTES = 12
KEY_BYTES = 32
STORAGE_KEY_PATTERN = re.compile(r"^[0-9a-f]{32}\.enc$")


class ImageVaultError(RuntimeError):
    pass


class ImageVault:
    """Encrypt generated PNGs with AES-256-GCM before retaining them on disk."""

    def __init__(self, image_dir: str | Path, key_path: str | Path, output_dir: str | Path):
        self.image_dir = Path(image_dir)
        self.key_path = Path(key_path)
        self.output_dir = Path(output_dir).resolve()
        self.image_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.image_dir.chmod(0o700)
        self.key_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.key_path.parent.chmod(0o700)
        self._cipher = AESGCM(self._load_or_create_key())

    def _load_or_create_key(self) -> bytes:
        try:
            descriptor = os.open(self.key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            pass
        else:
            key = os.urandom(KEY_BYTES)
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(key)
                stream.flush()
                os.fsync(stream.fileno())
            return key

        mode = stat.S_IMODE(self.key_path.stat().st_mode)
        if mode & 0o077:
            raise ImageVaultError(f"Image encryption key permissions are too broad: {mode:o}")
        key = self.key_path.read_bytes()
        if len(key) != KEY_BYTES:
            raise ImageVaultError("Image encryption key has an invalid length")
        return key

    def _source_path(self, image: dict[str, Any]) -> Path:
        filename = str(image.get("filename") or "")
        subfolder = str(image.get("subfolder") or "")
        if not filename or Path(filename).name != filename or "\\" in filename:
            raise ImageVaultError("ComfyUI returned an unsafe image filename")
        if "\\" in subfolder:
            raise ImageVaultError("ComfyUI returned an unsafe image subfolder")
        relative = Path(subfolder)
        if relative.is_absolute() or any(part in {"", ".", ".."} for part in relative.parts):
            if subfolder:
                raise ImageVaultError("ComfyUI returned an unsafe image subfolder")
        source = (self.output_dir / relative / filename).resolve(strict=True)
        if os.path.commonpath((str(self.output_dir), str(source))) != str(self.output_dir):
            raise ImageVaultError("ComfyUI image path escaped its output directory")
        if not source.is_file():
            raise ImageVaultError("ComfyUI output image is not a regular file")
        return source

    def encrypt_output(self, image: dict[str, Any]) -> dict[str, Any]:
        source = self._source_path(image)
        storage_key = f"{uuid.uuid4().hex}.enc"
        destination = self.image_dir / storage_key
        temporary = self.image_dir / f".{storage_key}.tmp"
        nonce = os.urandom(NONCE_BYTES)
        plaintext = source.read_bytes()
        encrypted = MAGIC + nonce + self._cipher.encrypt(nonce, plaintext, storage_key.encode("ascii"))
        try:
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(encrypted)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, destination)
            source.unlink()
            self._remove_empty_parents(source.parent)
        except Exception:
            temporary.unlink(missing_ok=True)
            # A failed encryption must not leave an unencrypted generated image.
            source.unlink(missing_ok=True)
            self._remove_empty_parents(source.parent)
            raise
        return {
            **image,
            "storage_path": storage_key,
            "content_type": mimetypes.guess_type(source.name)[0] or "image/png",
        }

    def decrypt(self, storage_key: str) -> bytes:
        if not STORAGE_KEY_PATTERN.fullmatch(storage_key):
            raise ImageVaultError("Invalid encrypted image key")
        path = self.image_dir / storage_key
        try:
            data = path.read_bytes()
        except FileNotFoundError as error:
            raise ImageVaultError("Encrypted image file is missing") from error
        header_length = len(MAGIC) + NONCE_BYTES
        if len(data) <= header_length or data[: len(MAGIC)] != MAGIC:
            raise ImageVaultError("Encrypted image has an invalid header")
        nonce = data[len(MAGIC) : header_length]
        try:
            return self._cipher.decrypt(nonce, data[header_length:], storage_key.encode("ascii"))
        except Exception as error:
            raise ImageVaultError("Encrypted image failed authentication") from error

    def delete(self, storage_key: str) -> None:
        if not STORAGE_KEY_PATTERN.fullmatch(storage_key):
            raise ImageVaultError("Invalid encrypted image key")
        (self.image_dir / storage_key).unlink(missing_ok=True)

    def _remove_empty_parents(self, directory: Path) -> None:
        current = directory
        while current != self.output_dir and current.is_relative_to(self.output_dir):
            try:
                current.rmdir()
            except OSError:
                break
            current = current.parent
