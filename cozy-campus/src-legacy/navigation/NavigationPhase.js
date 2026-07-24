// A fase responde somente "em qual etapa principal da navegação o ator está?".
// Detalhes independentes, como intenção e motivo de espera, vivem no
// NavigationAgent e não devem ser codificados criando novas fases.
export const NavigationPhase = Object.freeze({
    IDLE: "idle",
    PLANNING: "planning",
    TRAVERSING: "traversing",
    WAITING: "waiting",
    ENTERING_INTERACTION: "entering-interaction",
    INTERACTING: "interacting",
    LEAVING_INTERACTION: "leaving-interaction",
    RECOVERING: "recovering"
});
