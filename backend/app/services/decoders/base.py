from typing import Dict, Any

class BaseDecoder:
    async def decode(self, raw: bytes) -> Dict[str, Any]:
        raise NotImplementedError("Decoder must implement decode")
