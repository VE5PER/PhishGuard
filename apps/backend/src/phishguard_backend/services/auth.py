"""Authentication and authorization skeleton service."""

from typing import Optional
from fastapi import Header, HTTPException, status


class AuthGatewayService:
    """High-level authentication skeleton for client extension and edge gateways."""

    def __init__(self, dev_mode: bool = True):
        self.dev_mode = dev_mode
        self.valid_api_keys = {"phishguard_poc_key_2026", "test_client_key"}

    def verify_client_token(self, authorization: Optional[str] = Header(None)) -> bool:
        """Validate client bearer token or API key.

        In dev/POC mode, missing headers are allowed for local development.
        """
        if self.dev_mode and not authorization:
            return True

        if not authorization:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Missing authentication credentials",
            )

        token = authorization.replace("Bearer ", "").strip()
        if token in self.valid_api_keys:
            return True

        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Invalid or expired client credentials",
        )


auth_service = AuthGatewayService()
