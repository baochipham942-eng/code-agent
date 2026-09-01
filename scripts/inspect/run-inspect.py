"""Inspect CLI launcher that registers Tokenrhythm's custom model first."""

from inspect_ai.model import ModelInfo, set_model_info

set_model_info(
    "openai/deepseek-v4-flash",
    ModelInfo(
        context_length=1_000_000,
        output_tokens=32_768,
        organization="Tokenrhythm",
        model="deepseek-v4-flash",
        reasoning=True,
    ),
)

from inspect_ai._cli.main import main  # noqa: E402

main()
