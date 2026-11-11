"""The R2 endpoint and credentials file format shared by the publish scripts (standard library only)."""
import configparser
from pathlib import Path

ENDPOINT = 'https://f147815debbc98aca5b60c0caeeb29e6.r2.cloudflarestorage.com'


def load_credentials(path: Path) -> tuple[str, str]:
    cfg = configparser.ConfigParser()
    cfg.read(path)
    section = cfg["default"]
    return section["aws_access_key_id"], section["aws_secret_access_key"]
