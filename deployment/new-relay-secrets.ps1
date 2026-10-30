# Produces one pair of role-scoped random tokens. Output is secret: copy to a
# private deployment .env and the intended device only; do not paste into logs.
param([ValidatePattern('^[A-Za-z0-9_-]{1,80}$')][string]$DeviceId = 'office-pc')
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
try {
    function New-RelayToken {
        $bytes = New-Object byte[] 32
        $rng.GetBytes($bytes)
        return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    }
    $credentials = @{}
    $credentials[$DeviceId] = @{ hostToken = (New-RelayToken); viewerToken = (New-RelayToken) }
    $credentials | ConvertTo-Json -Depth 3 -Compress
}
finally { $rng.Dispose() }
