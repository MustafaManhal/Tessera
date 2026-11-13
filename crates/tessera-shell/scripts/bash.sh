# --rcfile shim. User startup files are sourced, never edited.
_tessera_integration_dir=$TESSERA_SHELL_DIR
unset TESSERA_SHELL_DIR
if [[ ${TESSERA_BASH_LOGIN:-0} == 1 ]]; then
    unset TESSERA_BASH_LOGIN
    shopt -s login_shell
    [[ -r /etc/profile ]] && source /etc/profile
    for _tessera_profile in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
        if [[ -r $_tessera_profile ]]; then source "$_tessera_profile"; break; fi
    done
else
    [[ -r $HOME/.bashrc ]] && source "$HOME/.bashrc"
fi
[[ $- == *i* && ${SHELL_INTEGRATION:-on} != off && -z ${_tessera_bash_installed-} ]] || return
_tessera_bash_installed=1
_tessera_command_active=0
_tessera_prompt_ready=0
_tessera_mark_a=$'\\[\e]133;A\a\\]'
_tessera_mark_b=$'\\[\e]133;B\a\\]'
_tessera_cwd() {
    local LC_ALL=C c hex encoded='' i
    for ((i=0; i<${#PWD}; i++)); do
        c=${PWD:i:1}
        case $c in
            [a-zA-Z0-9/._~-]) encoded+=$c ;;
            *) printf -v hex '%d' "'$c"; printf -v hex '%%%02X' "$((hex & 255))"; encoded+=$hex ;;
        esac
    done
    printf '\033]7;file://%s%s\007' "${HOSTNAME//[^a-zA-Z0-9.-]/_}" "$encoded"
}
_tessera_prompt_begin() {
    local result=$?
    _tessera_prompt_ready=0
    if (( _tessera_command_active )); then
        printf '\033]133;D;%s\007' "$result"
        _tessera_command_active=0
    fi
    _tessera_cwd
    return "$result"
}
_tessera_prompt_end() {
    PS1=${PS1#"$_tessera_mark_a"}
    PS1=${PS1%"$_tessera_mark_b"}
    PS1=$_tessera_mark_a$PS1$_tessera_mark_b
    _tessera_prompt_ready=1
}
_tessera_debug() {
    local result=$1 command=$2
    if [[ $_tessera_prompt_ready == 1 && $BASH_SUBSHELL == 0 && $command != _tessera_prompt_begin* ]]; then
        _tessera_prompt_ready=0
        _tessera_command_active=1
        printf '\033]133;C\007'
    fi
    if [[ -n $_tessera_previous_debug ]]; then
        _tessera_return_status "$result"
        builtin eval "$_tessera_previous_debug"
    fi
}
_tessera_return_status() { return "$1"; }
# Bash 3.2 also supports arrays, but only newer Bash executes PROMPT_COMMAND arrays.
# Flatten the existing entries with newlines to preserve comments and command order.
_tessera_prompt_commands=("${PROMPT_COMMAND[@]}")
PROMPT_COMMAND=$'_tessera_prompt_begin\n'
for _tessera_pc in "${_tessera_prompt_commands[@]}"; do PROMPT_COMMAND+="$_tessera_pc"$'\n'; done
PROMPT_COMMAND+='_tessera_prompt_end'
_tessera_trap=$(trap -p DEBUG)
_tessera_previous_debug=''
if [[ -n $_tessera_trap ]]; then
    _tessera_trap=${_tessera_trap#trap -- }
    _tessera_trap=${_tessera_trap% DEBUG}
    builtin eval "_tessera_previous_debug=$_tessera_trap"
fi
trap '_tessera_debug "$?" "$BASH_COMMAND"' DEBUG
