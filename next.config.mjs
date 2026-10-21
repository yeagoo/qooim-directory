export default {
  poweredByHeader:false,
  // sharp is intentionally excluded; serve original images instead.
  images:{unoptimized:true},
  webpack(config){config.resolve.extensionAlias={...config.resolve.extensionAlias,'.js':['.ts','.js']};return config;},
};
