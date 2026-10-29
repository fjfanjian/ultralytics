$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$python = Join-Path $PSScriptRoot '.venv/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $python)) {
    python -m venv --system-site-packages .venv
    if ($LASTEXITCODE -ne 0) { throw 'Python 环境创建失败' }
}
& $python -c "import torch, torchvision, cv2, PIL, numpy; d='cuda' if torch.cuda.is_available() else 'cpu'; torchvision.ops.nms(torch.zeros((1,4),device=d),torch.ones(1,device=d),0.5)"
if ($LASTEXITCODE -ne 0) {
    & $python -m pip install torch==2.13.0 torchvision==0.28.0 --index-url https://download.pytorch.org/whl/cu130
    if ($LASTEXITCODE -ne 0) { throw 'PyTorch 安装失败' }
    & $python -m pip install -e ../..
    if ($LASTEXITCODE -ne 0) { throw '依赖安装失败，请检查网络和 Python 环境' }
}
& $python -c 'import clip'
if ($LASTEXITCODE -ne 0) {
    & $python -m pip install ftfy regex
    & $python -m pip install --no-deps 'git+https://github.com/ultralytics/CLIP.git@7ffa84b3bfa40c42ecc1c77147a855e69cb2dd40'
    if ($LASTEXITCODE -ne 0) { throw '文本编码依赖安装失败，请检查网络' }
}
& $python server.py @args
