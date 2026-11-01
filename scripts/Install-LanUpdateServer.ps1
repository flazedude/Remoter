[CmdletBinding()]
param([string]$Address, [switch]$AdminPhase, [string]$BundlePath, [string]$ExpectedUserSid)
$ErrorActionPreference = 'Stop'

function Get-RemoterAddress {
    $taskAddresses = @(Get-NetIPAddress -AddressFamily IPv4 | Select-Object -ExpandProperty IPAddress)
    if ($Address) {
        if ($Address -notin @('192.168.2.76','192.168.2.59') -or $Address -notin $taskAddresses) { throw 'Choose this computer''s reserved Jack PC (.76) or GPD PC (.59) LAN address.' }
        return $Address
    }
    $taskMatches = @($taskAddresses | Where-Object { $_ -in @('192.168.2.76','192.168.2.59') })
    if ($taskMatches.Count -ne 1) { throw 'Run this on Jack PC or GPD PC with its reserved LAN address.' }
    return $taskMatches[0]
}

$Address = Get-RemoterAddress
if (!$AdminPhase) {
    # Stage locally before elevation: elevated sessions may not have Z: mapped.
    $taskStage = Join-Path $env:LOCALAPPDATA ('RemoterLanSetup-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $taskStage | Out-Null
    $taskRepository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $taskBinary = Join-Path $PSScriptRoot 'remoter-update-server.exe'
    $taskConfig = Join-Path $PSScriptRoot 'update-config.json'
    if (!(Test-Path -LiteralPath $taskBinary)) { $taskBinary = Join-Path $taskRepository 'native\bin\remoter-update-server.exe' }
    if (!(Test-Path -LiteralPath $taskConfig)) { $taskConfig = Join-Path $taskRepository 'updates\config.json' }
    Copy-Item -LiteralPath $taskBinary -Destination (Join-Path $taskStage 'remoter-update-server.exe')
    Copy-Item -LiteralPath $taskConfig -Destination (Join-Path $taskStage 'update-config.json')
    Copy-Item -LiteralPath $PSCommandPath -Destination (Join-Path $taskStage 'Install-LanUpdateServer.ps1')
    $taskSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $taskPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $taskArguments = '-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $taskStage 'Install-LanUpdateServer.ps1') + '" -AdminPhase -BundlePath "' + $taskStage + '" -ExpectedUserSid "' + $taskSid + '" -Address ' + $Address
    $taskProcess = Start-Process -FilePath $taskPowerShell -ArgumentList $taskArguments -Verb RunAs -WindowStyle Hidden -PassThru
    Write-Output "Administrator setup started (PID $($taskProcess.Id)). Result: $taskStage\result.json"
    return
}

try {
    $taskIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if ($taskIdentity.User.Value -ne $ExpectedUserSid -or !([Security.Principal.WindowsPrincipal]::new($taskIdentity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Approve administrator access for the same Windows account.' }
    $taskRoot = Join-Path $env:ProgramData 'RemoterUpdateServer'
    $taskExe = Join-Path $taskRoot 'remoter-update-server.exe'
    $taskConfigPath = Join-Path $taskRoot 'update-config.json'
    $taskNewConfig = Get-Content -LiteralPath (Join-Path $BundlePath 'update-config.json') -Raw | ConvertFrom-Json
    if ($taskNewConfig.repository -cne 'flazedude/Remoter' -or $taskNewConfig.channel -cne 'alpha') { throw 'Unexpected update identity.' }
    if (Test-Path -LiteralPath $taskConfigPath) {
        $taskOldConfig = Get-Content -LiteralPath $taskConfigPath -Raw | ConvertFrom-Json
        if ($taskOldConfig.publicKey -cne $taskNewConfig.publicKey) { throw 'Existing Remoter update identity differs. It was preserved.' }
    }
    $taskName = 'Remoter LAN Updates'
    $taskExisting = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($taskExisting) {
        if (@($taskExisting.Actions).Count -ne 1 -or $taskExisting.Actions[0].Execute -ine $taskExe) { throw 'An unrelated scheduled task uses this name. It was preserved.' }
        Stop-ScheduledTask -TaskName $taskName
        Start-Sleep -Seconds 2
    }
    New-Item -ItemType Directory -Force -Path $taskRoot | Out-Null
    # Only administrators/SYSTEM may replace a boot-time executable or public key.
    & icacls $taskRoot /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not protect the update-server directory.' }
    Copy-Item -LiteralPath (Join-Path $BundlePath 'remoter-update-server.exe') -Destination $taskExe -Force
    Copy-Item -LiteralPath (Join-Path $BundlePath 'update-config.json') -Destination $taskConfigPath -Force
    $taskPublic = Join-Path $taskRoot 'public'
    $taskAction = New-ScheduledTaskAction -Execute $taskExe -Argument ('--listen ' + $Address + ':17846 --root "' + $taskPublic + '" --config "' + $taskConfigPath + '"') -WorkingDirectory $taskRoot
    $taskTrigger = New-ScheduledTaskTrigger -AtStartup
    $taskTrigger.Delay = 'PT30S'
    $taskSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $taskTrigger -Settings $taskSettings -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
    $taskRuleName = 'Remoter-LAN-Updates'
    if (Get-NetFirewallRule -Name $taskRuleName -ErrorAction SilentlyContinue) {
        $taskRule = Get-NetFirewallRule -Name $taskRuleName
        $taskPort = $taskRule | Get-NetFirewallPortFilter
        $taskApplication = $taskRule | Get-NetFirewallApplicationFilter
        $taskScope = $taskRule | Get-NetFirewallAddressFilter
        if ($taskPort.LocalPort -ne '17846' -or $taskApplication.Program -ine $taskExe -or $taskScope.LocalAddress -ne $Address -or $taskScope.RemoteAddress -ne 'LocalSubnet' -or $taskRule.Action -ne 'Allow' -or $taskRule.Direction -ne 'Inbound' -or $taskRule.Enabled -ne 'True') { throw 'Existing Remoter firewall rule differs. Review it before setup; it was preserved.' }
    } else {
        New-NetFirewallRule -Name $taskRuleName -DisplayName 'Remoter LAN updates' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 17846 -LocalAddress $Address -RemoteAddress LocalSubnet -Profile Any -Program $taskExe | Out-Null
    }
    Start-ScheduledTask -TaskName $taskName
    $taskHealthy = $false
    for ($taskAttempt = 0; $taskAttempt -lt 30; $taskAttempt++) {
        try {
            $taskRequest = [Net.HttpWebRequest]::Create("http://${Address}:17846/health"); $taskRequest.Proxy = $null; $taskRequest.Timeout = 2000
            $taskResponse = $taskRequest.GetResponse(); $taskReader = New-Object IO.StreamReader($taskResponse.GetResponseStream())
            try { $taskHealthy = $taskReader.ReadToEnd() -ceq 'Remoter LAN update server' } finally { $taskReader.Dispose(); $taskResponse.Dispose() }
            if ($taskHealthy) { break }
        } catch { Start-Sleep -Milliseconds 500 }
    }
    if (!$taskHealthy) { throw 'The startup task was configured but its HTTP health check failed.' }
    @{ success=$true; address=$Address; task=$taskName; healthVerified=$true; mirror='GitHub refresh at startup and every five minutes; feed availability is verified separately.'; completedAt=[DateTimeOffset]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $BundlePath 'result.json')
} catch {
    @{ success=$false; error=$_.Exception.Message; completedAt=[DateTimeOffset]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $BundlePath 'result.json')
    exit 1
}
