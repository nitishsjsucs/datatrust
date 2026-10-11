from datatrust import __version__
from datatrust.cli import main


def test_version_is_set():
    assert __version__ == "0.1.0"


def test_cli_without_command_prints_help(capsys):
    assert main([]) == 0
    assert "datatrust" in capsys.readouterr().out
