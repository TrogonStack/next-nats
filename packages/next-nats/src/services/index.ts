import "server-only";

export {
  defineService,
  endpoint,
  endpointSubject,
  stopAllServices,
  SERVICE_INSTANCE_HEADER,
  type EndpointContext,
  type EndpointDefinition,
  type EndpointMap,
  type ServiceConfigInput,
  type ServiceDefinition,
} from "./define.js";
export {
  serviceClient,
  type CallOptions,
  type EndpointClient,
  type GatherOptions,
  type GatherResult,
  type ServiceClientOf,
  type ServiceClientOptions,
} from "./client.js";
export { discover, type Discovery, type DiscoverOptions } from "./discovery.js";
export { EndpointError, ServiceCallError, type ServiceCallFailure } from "./errors.js";
export {
  runParser,
  ValidationError,
  type Parser,
  type ParserFn,
  type StandardSchemaIssue,
  type StandardSchemaResult,
  type StandardSchemaV1,
} from "./schema.js";
