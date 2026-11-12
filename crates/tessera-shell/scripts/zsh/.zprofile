_tessera_restore_zdotdir
[[ -r ${ZDOTDIR:-$HOME}/.zprofile ]] && source "${ZDOTDIR:-$HOME}/.zprofile"
_tessera_zdotdir_set=${+ZDOTDIR}
_tessera_user_zdotdir=${ZDOTDIR-}
[[ -o rcs ]] && export ZDOTDIR=$_tessera_integration_dir/zsh
