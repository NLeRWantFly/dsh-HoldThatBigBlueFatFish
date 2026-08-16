$script:Dsv4EspIdfImage = if ($env:DSV4_ESP_IDF_DOCKER_IMAGE) {
    $env:DSV4_ESP_IDF_DOCKER_IMAGE
} else {
    'espressif/idf:v6.0.1'
}

function Convert-Dsv4EspIdfArgument {
    param([Parameter(Mandatory = $true)][string]$Value)

    $workspace = (Get-Location).Path.TrimEnd('\')
    if ($Value.StartsWith($workspace, [System.StringComparison]::OrdinalIgnoreCase)) {
        $suffix = $Value.Substring($workspace.Length).Replace('\', '/')
        return "/project$suffix"
    }
    return $Value
}

function Invoke-Dsv4EspIdfDocker {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][object[]]$Arguments
    )

    $workspace = (Get-Location).Path
    $mount = "type=bind,source=$workspace,target=/project"
    & docker run --rm --mount $mount -w /project $script:Dsv4EspIdfImage $Command @Arguments
    $exitCode = $LASTEXITCODE
    $global:LASTEXITCODE = $exitCode
    return $exitCode
}

function global:idf.py {
    $mapped = @($args | ForEach-Object { Convert-Dsv4EspIdfArgument -Value ([string]$_) })
    $null = Invoke-Dsv4EspIdfDocker -Command 'idf.py' -Arguments $mapped
}

function global:cmake {
    $mapped = @($args | ForEach-Object { Convert-Dsv4EspIdfArgument -Value ([string]$_) })
    $null = Invoke-Dsv4EspIdfDocker -Command 'cmake' -Arguments $mapped
}
