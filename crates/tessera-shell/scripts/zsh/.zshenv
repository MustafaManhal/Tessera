# Restore the user's startup directory before reading their files. Never write to it.
_tessera_integration_dir=$TESSERA_SHELL_DIR
_tessera_zdotdir_set=${TESSERA_ZDOTDIR_SET:-0}
_tessera_user_zdotdir=${TESSERA_ZDOTDIR-}
unset TESSERA_SHELL_DIR TESSERA_ZDOTDIR TESSERA_ZDOTDIR_SET
_tessera_restore_zdotdir() {
    if [[ $_tessera_zdotdir_set == 1 ]]; then
        export ZDOTDIR=$_tessera_user_zdotdir
    else
        unset ZDOTDIR
    fi
}
_tessera_restore_zdotdir
[[ -r ${ZDOTDIR:-$HOME}/.zshenv ]] && source "${ZDOTDIR:-$HOME}/.zshenv"
_tessera_zdotdir_set=${+ZDOTDIR}
_tessera_user_zdotdir=${ZDOTDIR-}
if [[ -o interactive && -o rcs ]]; then
    export ZDOTDIR=$_tessera_integration_dir/zsh
fi
