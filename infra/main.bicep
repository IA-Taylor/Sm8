// Azure infra for the SM8 -> Zunos -> EPAN part-order bot.
//
// Deploys:
//   * Storage Account (used both as the Function App's required backing
//     storage AND as our pendingOrders Table Storage).
//   * Application Insights for logs.
//   * Function App (Linux, Node 20, Flex Consumption plan).
//   * Key Vault (RBAC mode) holding the SM8 / Zunos / EPAN secrets.
//   * Role assignments granting the Function App's managed identity:
//       - Storage Table Data Contributor on the storage account
//       - Key Vault Secrets User on the Key Vault
//
// After `az deployment group create` succeeds, seed the Key Vault secrets
// (see README) and `func azure functionapp publish <name>` to ship code.

@description('Base name; resources are named <baseName><suffix>.')
param baseName string = 'sm8partbot'

@description('Azure region for all resources.')
param location string = resourceGroup().location

var suffix = uniqueString(resourceGroup().id)
// Storage account names: 3-24 chars, lowercase letters and digits only.
var storageAccountName = take(toLower('${baseName}st${suffix}'), 24)
var functionAppName = '${baseName}-fn-${suffix}'
var planName = '${baseName}-plan-${suffix}'
var keyVaultName = take('${baseName}-kv-${suffix}', 24)
var appInsightsName = '${baseName}-ai-${suffix}'
var pendingOrdersTableName = 'pendingOrders'

// ---------------- Storage ----------------

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
  }
}

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource pendingOrdersTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: pendingOrdersTableName
}

// ---------------- App Insights ----------------

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    Request_Source: 'rest'
  }
}

// ---------------- Function App ----------------

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: planName
  location: location
  sku: {
    name: 'Y1'
    tier: 'Dynamic'
  }
  properties: {
    reserved: true // Linux
  }
}

resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: functionAppName
  location: location
  kind: 'functionapp,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'NODE|20'
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      appSettings: [
        { name: 'AzureWebJobsStorage__accountName', value: storage.name }
        { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
        { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'node' }
        { name: 'WEBSITE_NODE_DEFAULT_VERSION', value: '~20' }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }
        { name: 'KEY_VAULT_URL', value: keyVault.properties.vaultUri }
        { name: 'STORAGE_ACCOUNT_NAME', value: storage.name }
        { name: 'PENDING_ORDERS_TABLE', value: pendingOrdersTableName }
        { name: 'ZUNOS_BASE_URL', value: 'https://api.zunos.com' }
        { name: 'ZUNOS_SEARCH_PATH', value: '/v1/content/search' }
        { name: 'EPAN_BASE_URL', value: 'https://e-pan.panasonic.com.au' }
        { name: 'SM8_BOT_STAFF_UUID', value: '' }
      ]
    }
  }
}

// ---------------- Key Vault ----------------

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    sku: { family: 'A', name: 'standard' }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    publicNetworkAccess: 'Enabled'
  }
}

// ---------------- Role assignments ----------------

// Storage Table Data Contributor — lets the Function App read/write the table
var tableContributorRoleId = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'

resource storageRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, functionApp.id, tableContributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', tableContributorRoleId)
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// Key Vault Secrets User — lets the Function App read secrets
var kvSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

resource kvRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: keyVault
  name: guid(keyVault.id, functionApp.id, kvSecretsUserRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', kvSecretsUserRoleId)
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// ---------------- Outputs ----------------

output functionAppName string = functionApp.name
output webhookUrl string = 'https://${functionApp.properties.defaultHostName}/api/sm8/webhook'
output keyVaultName string = keyVault.name
output storageAccountName string = storage.name
output pendingOrdersTable string = pendingOrdersTableName
