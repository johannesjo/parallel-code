# ML Kit discovers component registrars through manifest metadata and reflection. The scanner's
# firebase-components 16.1.0 dependency keeps the classes but not their constructors in R8 full mode.
# These are the corrected consumer rules shipped by firebase-components 19.0.0.
# https://github.com/googlesamples/mlkit/issues/1018
-keep class * implements com.google.firebase.components.ComponentRegistrar { void <init>(); }
-keep,allowshrinking interface com.google.firebase.components.ComponentRegistrar
