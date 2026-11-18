_tessera_restore_zdotdir
[[ -r ${ZDOTDIR:-$HOME}/.zshrc ]] && source "${ZDOTDIR:-$HOME}/.zshrc"
_tessera_zdotdir_set=${+ZDOTDIR}
_tessera_user_zdotdir=${ZDOTDIR-}
source "$_tessera_integration_dir/zsh/integration.zsh"
if [[ -o login && -o rcs ]]; then
    export ZDOTDIR=$_tessera_integration_dir/zsh
else
    _tessera_restore_zdotdir
fi
