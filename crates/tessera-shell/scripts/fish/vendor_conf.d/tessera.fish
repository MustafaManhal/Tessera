# Restore the caller's environment after fish has discovered vendor snippets.
if set -q TESSERA_XDG_DATA_DIRS_SET; and test "$TESSERA_XDG_DATA_DIRS_SET" = 1
    set -gx XDG_DATA_DIRS "$TESSERA_XDG_DATA_DIRS"
else
    set -e XDG_DATA_DIRS
end
set -e TESSERA_XDG_DATA_DIRS TESSERA_XDG_DATA_DIRS_SET TESSERA_SHELL_DIR
status is-interactive; or return
if test "$SHELL_INTEGRATION" = off; or set -q _tessera_fish_installed
    return
end
set -g _tessera_fish_installed 1
function _tessera_cwd
    set -l cwd (string escape --style=url -- "$PWD" | string replace -a '%2F' '/')
    set -l host (string replace -ra '[^a-zA-Z0-9.-]' '_' -- "$hostname")
    printf '\e]7;file://%s%s\a' "$host" "$cwd"
end
# Fish 4+ already emits semantic markers when mark-prompt is enabled.
if status test-feature mark-prompt 2>/dev/null
    function _tessera_native_cwd --on-event fish_prompt
        _tessera_cwd
    end
    return
end
# Fish 4.0 prints the A, C and D marks itself (but not B), so only add what it lacks: doubling them breaks block
# detection. Older fish prints none and gets all four from us.
set -g _tessera_fish_native 0
set -l _tessera_fish_major (string match -r '^[0-9]+' -- $version)
if test -n "$_tessera_fish_major"; and test "$_tessera_fish_major" -ge 4
    set -g _tessera_fish_native 1
end
function _tessera_preexec --on-event fish_preexec
    test $_tessera_fish_native = 0; and printf '\e]133;C\a'
end
function _tessera_postexec --on-event fish_postexec
    set -l result $status
    test $_tessera_fish_native = 0; and printf '\e]133;D;%s\a' $result
end
function _tessera_return_status
    return $argv[1]
end
# User config.fish loads after vendor snippets. Defer wrapping until its first prompt.
function _tessera_before_prompt --on-event fish_prompt
    set -g _tessera_prompt_status $status
    if not functions -q _tessera_original_prompt
        functions -c fish_prompt _tessera_original_prompt
        function fish_prompt
            _tessera_cwd
            test $_tessera_fish_native = 0; and printf '\e]133;A\a'
            _tessera_return_status $_tessera_prompt_status
            _tessera_original_prompt
            printf '\e]133;B\a'
        end
    end
end
