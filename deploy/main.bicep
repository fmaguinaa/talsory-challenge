// =============================================================================
// Interseguro - Azure Container Apps.
//
// Azure Container Apps is the target because it matches the shape of the system
// rather than fighting it: every service is already a stateless container that
// scales horizontally, and ACA gives each one its own ingress, revision and
// scaling rules without a cluster to operate. The alternative (Cloud Run,
// ECS Fargate) would work equally well; see ADR-008.
//
// The security model is expressed here, not just in docker-compose.yml:
//
//   - Only `orchestrator` and `mobile-web` get an EXTERNAL ingress.
//   - The three backends get INTERNAL ingress, so they are unreachable from the
//     internet by construction rather than by firewall rule.
//   - Secrets come from Key Vault references; nothing sensitive is in this file
//     or in the repository.
// =============================================================================

targetScope = 'resourceGroup'

@description('Location for every resource. The Container Apps environment and its apps must share one.')
param location string = resourceGroup().location

@description('Name of the Container Apps environment.')
param environmentName string = 'interseguro-env'

@description('Prefix for the internal service names. The public host is derived from the orchestrator name.')
param namePrefix string = 'interseguro'

@description('Login server of the container registry holding the images.')
param containerRegistryServer string

@description('True in a production environment; false leaves the apps reachable with HTTP and relaxed settings.')
@allowed([true, false])
param isProduction bool = true

@description('Access policy object ids allowed to read the Key Vault secrets.')
param keyVaultAccessPolicies array = []

@description(
  'Comma-separated CORS allow-list for the orchestrator. It names the web front, whose URL is only known once that app exists, which is why it is a parameter rather than a reference. A wildcard is never acceptable here: this service is the only public backend.'
)
param corsOrigins string

@description('Tag applied to every resource, so the whole deployment can be found or costed.')
param tags object = {
  application: 'interseguro'
  managedBy: 'bicep'
}

// -----------------------------------------------------------------------------
// Key Vault
// -----------------------------------------------------------------------------

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: '${namePrefix}-kv'
  location: location
  tags: union(tags, { role: 'secrets' })
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    enableSoftDelete: true
    // A hard delete recovery window is short on purpose: this vault holds
    // secrets, not backups, and retaining purgeable secrets indefinitely
    // outlives their usefulness while widening the blast radius of a mistake.
    softDeleteRetentionInDays: 7
    enablePurgeProtection: false
    publicNetworkAccess: 'Enabled'
    enableRbacAuthorization: true
    accessPolicies: isProduction ? [] : keyVaultAccessPolicies
  }
}

// -----------------------------------------------------------------------------
// Container registry
// -----------------------------------------------------------------------------

resource registry 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: replace(replace(namePrefix, '-', ''), '_', '')
  location: location
  tags: union(tags, { role: 'registry' })
  sku: {
    name: 'Basic'
  }
  properties: {
    // Admin user is disabled: every pull is authenticated with the managed
    // identity of the container app, so there is no shared password to leak.
    adminUserEnabled: false
    publicNetworkAccess: 'Disabled'
    anonymousPullEnabled: false
  }
}

// -----------------------------------------------------------------------------
// Container Apps environment
// -----------------------------------------------------------------------------

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  tags: tags
  properties: {
    // Single-zone by default. Zone redundancy would be the next step for a
    // production deployment; it costs more and adds nothing to a demo, so the
    // parameter is exposed rather than hard-coded either way.
    zoneRedundant: false
  }
}

// -----------------------------------------------------------------------------
// Shared identity: one user-assigned identity for all five apps
// -----------------------------------------------------------------------------

resource appIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-identity'
  location: location
  tags: tags
}

resource identityRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, appIdentity.id, 'acrpull')
  properties: {
    principalId: appIdentity.properties.principalId
    // AcrPull is the narrowest role that lets an app pull an image, and it is
    // all this system needs.
    roleDefinitionId: subscriptionResourceId(subscription().subscriptionId, 'Microsoft.ContainerRegistry/registries/AcrPull')
    principalType: 'ServicePrincipal'
  }
}

// -----------------------------------------------------------------------------
// Per-service configuration
// -----------------------------------------------------------------------------

// The three backends share everything but their port, so they are described
// once and instantiated three times. Three near-identical app resources would
// be three places for a security setting to be wrong in exactly one of them.
// CPU is expressed in MILLICORES, not vCPUs. Container Apps budgets CPU that
// way, so 500 means 0.5 vCPU, and an integer removes any ambiguity about whether
// a fractional budget was meant. (It also sidesteps a Bicep parser limitation
// on a leading-dot decimal inside an array-of-objects literal.)
//
// Memory is a Kubernetes quantity string, e.g. '256Mi'.
@description('Settings for one internal, stateless backend service.')
param internalServices array = [
  {
    name: 'auth-service'
    port: 4000
    // The only service that receives the signing key pair. Least privilege is
    // expressed by what each app is given, not by what it is trusted to ignore.
    env: {
      JWT_TTL_SECONDS: '900'
      JWT_ISSUER: 'https://interseguro.local/auth'
      JWT_AUDIENCE: 'interseguro-api'
      AUTH_USERS: ''
      LOGIN_RATE_LIMIT_WINDOW_MS: '60000'
      LOGIN_RATE_LIMIT_MAX: '20'
    }
    // argon2 at the OWASP baseline needs room to work; the other two do not.
    cpuMillicores: 500
    memory: '256Mi'
    minReplicas: 1
    maxReplicas: 3
  }
  {
    name: 'qr-api'
    port: 8081
    env: {
      MAX_MATRIX_DIM: '100'
      QR_MAX_BODY_BYTES: '1048576'
      AUTH_CACHE_TTL_SECONDS: '30'
      AUTH_VALIDATE_TIMEOUT_MS: '1500'
    }
    cpuMillicores: 1000
    memory: '256Mi'
    minReplicas: 1
    maxReplicas: 5
  }
  {
    name: 'stats-api'
    port: 4001
    env: {
      MAX_MATRICES: '16'
      MAX_TOTAL_ELEMENTS: '20000'
      MAX_MATRIX_DIM: '100'
      STATS_MAX_BODY_BYTES: '1048576'
      DIAGONAL_EPSILON: '1e-9'
      AUTH_CACHE_TTL_SECONDS: '30'
      AUTH_VALIDATE_TIMEOUT_MS: '1500'
    }
    cpuMillicores: 500
    memory: '256Mi'
    minReplicas: 1
    maxReplicas: 3
  }
]

// -----------------------------------------------------------------------------
// Internal services
// -----------------------------------------------------------------------------

resource internalApps 'Microsoft.App/containerApps@2024-03-01' = [for svc in internalServices: {
  name: '${namePrefix}-${svc.name}'
  location: location
  tags: union(tags, { service: svc.name, exposure: 'internal' })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${appIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        // INTERNAL, not external-with-a-firewall: an internal app is unreachable
        // from the internet because the platform never gives it a public address.
        external: false
        targetPort: svc.port
        // Allow the orchestrator to call it. ACA's internal DNS resolves these
        // names within the environment, so no IP addresses appear here.
        allowInsecure: false
        transport: 'auto'
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
      registries: [
        {
          server: containerRegistryServer
          identity: appIdentity.id
        }
      ]
      secrets: [
        {
          // Key Vault reference: the value is resolved by the platform at
          // runtime, so it never appears in the app's environment listing, in a
          // revision's environment, or in a deployment log.
          name: 'jwt-private-key'
          keyVaultUrl: 'https://${keyVault.properties.vaultUri}secrets/jwt-private-key'
          identity: appIdentity.id
        }
        {
          name: 'jwt-public-key'
          keyVaultUrl: 'https://${keyVault.properties.vaultUri}secrets/jwt-public-key'
          identity: appIdentity.id
        }
        {
          name: 'service-api-keys'
          keyVaultUrl: 'https://${keyVault.properties.vaultUri}secrets/service-api-keys'
          identity: appIdentity.id
        }
        {
          name: 'demo-password-hash'
          keyVaultUrl: 'https://${keyVault.properties.vaultUri}secrets/demo-password-hash'
          identity: appIdentity.id
        }
      ]
    }
    template: {
      containers: [
        {
          image: '${containerRegistryServer}/${svc.name}:latest'
          name: svc.name
          resources: {
            // The integer millicore budget is turned into the vCPU fraction the
            // ARM API expects: 500 millicores -> 0.5 vCPU.
            cpu: svc.cpuMillicores / 1000
            memory: svc.memory
          }
          env: [
            {
              name: 'NODE_ENV'
              value: 'production'
            }
            {
              name: 'LOG_LEVEL'
              value: isProduction ? 'info' : 'debug'
            }
            {
              // Where to validate a caller's token. ACA's internal DNS resolves
              // this name to the auth-service app.
              name: 'AUTH_SERVICE_URL'
              value: 'http://${namePrefix}-auth-service'
            }
            {
              name: 'AUTH_SERVICE_KEY'
              // A secret reference, so the shared credential is never in the
              // revision's environment.
              secretRef: 'service-api-keys'
            }
            {
              name: 'AUTH_PORT'
              value: string(svc.port)
            }
            {
              name: 'QR_ADDR'
              value: '0.0.0.0:8081'
            }
            {
              name: 'STATS_PORT'
              value: '4001'
            }
          ]
        }
      ]
      scale: {
        // A floor of one means a service that is idle is still warm, which is
        // what keeps the first request after a quiet period fast.
        minReplicas: svc.minReplicas
        maxReplicas: svc.maxReplicas
        rules: [
          {
            name: 'cpu'
            http: {
              metadata: {
                concurrentRequests: '50'
              }
            }
          }
        ]
      }
    }
  }
}]

// -----------------------------------------------------------------------------
// Orchestrator: the only public API
// -----------------------------------------------------------------------------

resource orchestrator 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${namePrefix}-orchestrator'
  location: location
  tags: union(tags, { service: 'orchestrator', exposure: 'external' })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${appIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 3000
        // HTTPS only, and HTTP is redirected rather than served: a bearer token
        // sent in cleartext is a token that can be replayed by anyone on the path.
        allowInsecure: !isProduction
        transport: isProduction ? 'http' : 'http'
        // Sticky sessions are left unset on purpose: the service holds no
        // session state, so pinning a request to a replica would add state for
        // no benefit.
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
      registries: [
        {
          server: containerRegistryServer
          identity: appIdentity.id
        }
      ]
      secrets: [
        {
          name: 'service-api-keys'
          keyVaultUrl: 'https://${keyVault.properties.vaultUri}secrets/service-api-keys'
          identity: appIdentity.id
        }
      ]
    }
    template: {
      containers: [
        {
          image: '${containerRegistryServer}/orchestrator:latest'
          name: 'orchestrator'
          resources: {
            cpu: 1
            memory: '512Mi'
          }
          env: [
            {
              name: 'NODE_ENV'
              value: 'production'
            }
            {
              name: 'PORT'
              value: '3000'
            }
            {
              name: 'LOG_LEVEL'
              value: isProduction ? 'info' : 'debug'
            }
            {
              name: 'AUTH_SERVICE_URL'
              value: 'http://${namePrefix}-auth-service'
            }
            {
              name: 'QR_API_URL'
              value: 'http://${namePrefix}-qr-api'
            }
            {
              name: 'STATS_API_URL'
              value: 'http://${namePrefix}-stats-api'
            }
            {
              name: 'AUTH_SERVICE_KEY'
              secretRef: 'service-api-keys'
            }
            {
              // Supplied by the operator rather than derived from the front's
              // FQDN: deriving it would create a cycle, because the front's
              // API_URL points back at the orchestrator.
              name: 'CORS_ORIGINS'
              value: corsOrigins
            }
            {
              name: 'MAX_MATRIX_DIM'
              value: '100'
            }
            {
              name: 'DOWNSTREAM_TIMEOUT_MS'
              value: '3000'
            }
            {
              name: 'DOWNSTREAM_RETRIES'
              value: '1'
            }
            {
              name: 'THROTTLE_TTL_MS'
              value: '60000'
            }
            {
              name: 'THROTTLE_LIMIT'
              value: '120'
            }
          ]
          // Liveness and readiness are dependency-free by design, so a slow
          // auth-service never takes the orchestrator out of rotation. The
          // startup probe covers the slower Node boot.
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/health/live'
                port: 3000
              }
              initialDelaySeconds: 10
              periodSeconds: 20
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/health/ready'
                port: 3000
              }
              initialDelaySeconds: 5
              periodSeconds: 10
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        // A floor of two so a rolling revision does not take the only public
        // entry point offline.
        minReplicas: isProduction ? 2 : 1
        maxReplicas: 10
        rules: [
          {
            name: 'http-concurrency'
            http: {
              metadata: {
                concurrentRequests: '100'
              }
            }
          }
        ]
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Mobile web: the public front
// -----------------------------------------------------------------------------

resource mobileWeb 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${namePrefix}-mobile-web'
  location: location
  tags: union(tags, { service: 'mobile-web', exposure: 'external' })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${appIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        allowInsecure: !isProduction
        transport: 'http'
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
      registries: [
        {
          server: containerRegistryServer
          identity: appIdentity.id
        }
      ]
    }
    template: {
      containers: [
        {
          image: '${containerRegistryServer}/mobile-web:latest'
          name: 'mobile-web'
          resources: {
            // A static site behind nginx needs almost nothing; 250 millicores
            // is enough to serve hashed assets from the page cache.
            cpu: 250 / 1000
            memory: '64Mi'
          }
          env: [
            {
              // Rendered into /config.json at container start, which is what
              // makes one web image promotable between environments.
              name: 'API_URL'
              value: 'https://${orchestrator.properties.configuration.ingress.fqdn}'
            }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/'
                port: 8080
              }
              initialDelaySeconds: 5
              periodSeconds: 20
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        // The front is static files behind nginx; one replica serves it and two
        // would only duplicate cache warmth.
        minReplicas: 1
        maxReplicas: 3
        rules: [
          {
            name: 'cpu'
            http: {
              metadata: {
                concurrentRequests: '200'
              }
            }
          }
        ]
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Outputs
// -----------------------------------------------------------------------------

@description('Public URL of the orchestrator.')
output orchestratorUrl string = 'https://${orchestrator.properties.configuration.ingress.fqdn}'

@description('Public URL of the web front.')
output mobileWebUrl string = 'https://${mobileWeb.properties.configuration.ingress.fqdn}'

@description('Key Vault holding the signing keys and the service credential.')
output keyVaultName string = keyVault.name

@description('Container registry login server.')
output containerRegistryLoginServer string = registry.properties.loginServer

@description('Name of the managed identity shared by all five apps.')
output identityName string = appIdentity.name
