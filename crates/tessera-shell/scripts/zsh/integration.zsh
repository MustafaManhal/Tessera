# Original Tessera implementation. The user's hooks remain in their original order.
[[ -o interactive && ${SHELL_INTEGRATION:-on} != off && -z ${_tessera_zsh_installed-} ]] || return
_tessera_zsh_installed=1
_tessera_command_active=0
_tessera_mark_a=$'%{\e]133;A\a%}'
_tessera_mark_b=$'%{\e]133;B\a%}'
_tessera_cwd() {
    emulate -L zsh
    local LC_ALL=C c encoded='' hex i
    for ((i=1; i<=${#PWD}; i++)); do
        c=${PWD[i]}
        case $c in
            [a-zA-Z0-9/._~-]) encoded+=$c ;;
            *) printf -v hex '%%%02X' "'$c"; encoded+=$hex ;;
        esac
    done
    printf '\e]7;file://%s%s\a' "${HOST//[^a-zA-Z0-9.-]/_}" "$encoded"
}
_tessera_precmd() {
    local result=$?
    if (( _tessera_command_active )); then
        printf '\e]133;D;%s\a' "$result"
        _tessera_command_active=0
    fi
    _tessera_cwd
    PS1=${PS1#$_tessera_mark_a}
    PS1=${PS1%$_tessera_mark_b}
    PS1=$_tessera_mark_a$PS1$_tessera_mark_b
    return "$result"
}
_tessera_preexec() {
    _tessera_command_active=1
    printf '\e]133;C\a'
}
# Capture status before user precmd hooks can change it, wrap the prompt after them.
_tessera_capture_status() { _tessera_exit=$?; return "$_tessera_exit"; }
_tessera_finish_prompt() {
    _tessera_return_status "$_tessera_exit"
    _tessera_precmd
}
_tessera_return_status() { return "$1"; }
typeset -ga precmd_functions preexec_functions
precmd_functions=(_tessera_capture_status $precmd_functions _tessera_finish_prompt)
preexec_functions+=(_tessera_preexec)
