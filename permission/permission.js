document.getElementById('ask').addEventListener('click', async () => {
  const result = document.getElementById('result');
  const help = document.getElementById('help');
  result.className = 'result';
  result.textContent = 'Aguardando a sua resposta ao Chrome...';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    result.className = 'result ok';
    result.textContent = 'Permissão concedida. Pode fechar esta aba e clicar em "Iniciar copiloto" no painel.';
    help.hidden = true;
  } catch (err) {
    result.className = 'result err';
    result.textContent = err?.name === 'NotFoundError'
      ? 'Nenhum microfone foi encontrado neste computador.'
      : 'Permissão negada (' + (err?.name || 'erro') + ').';
    help.hidden = false;
  }
});
